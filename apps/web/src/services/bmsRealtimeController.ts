import { bmsApi, BmsApiError } from './bmsRealtimeApi';
import { useBmsRealtimeStore as store } from '../store/bmsRealtime';
import { BMS_METRICS } from './bmsRealtimeTypes';
import type { BmsMetric, BmsSample, TrendPoint, ViewerLease } from './bmsRealtimeTypes';

const pageQueues = new WeakMap<object, Map<string, Promise<void>>>();
function pageQueue(api: object, pageId?: string) {
  let queues = pageQueues.get(api);
  if (!queues) { queues = new Map(); pageQueues.set(api, queues); }
  const key = pageId ?? 'legacy';
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const previous = queues!.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      const tail = current.then(() => {}, () => {});
      queues!.set(key, tail);
      void tail.then(() => { if (queues!.get(key) === tail) queues!.delete(key); });
      return current;
    },
  };
}
async function boundedRelease(release: () => Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    release().then(() => true, () => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

/** 每个BMS面板维护一个来源过滤租约，并在重连时保留本地一小时历史。 */
export class BmsRealtimeController {
  private generation = 0;
  private events: EventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private trendRefresh: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | null = null;
  private retryCount = 0;
  private pageId?:string;
  private trendCursors: Partial<Record<BmsMetric, string | null>> = {};
  private queryKeys: Partial<Record<BmsMetric, string>> = {};
  private fetching = new Set<string>();
  private permissionRevoked?: (deviceId: string) => void;
  constructor(private api = bmsApi, private openEvents = (url: string) => new EventSource(url), private releaseWaitMs = 5500) {}

  setPermissionRevokedHandler(handler?: (deviceId: string) => void) { this.permissionRevoked = handler; }

  stop(phase: 'idle' | 'paused' | 'expired' | 'unauthorized' = 'idle') {
    this.generation++;
    this.cleanup(phase);
  }

  private cleanup(phase: 'idle' | 'paused' | 'expired' | 'unauthorized' | 'reconnecting') {
    this.abort?.abort(); this.abort = null;
    clearTimeout(this.timer); clearTimeout(this.retry); clearTimeout(this.trendRefresh);
    this.events?.close(); this.events = null;
    const lease = store.getState().lease;
    store.setState({ phase, lease: null, websiteConnected: false });
    if (lease) {
      const queue = pageQueue(this.api, this.pageId);
      void queue.run(() => boundedRelease(() => this.api.release(lease.viewerId), this.releaseWaitMs).then(() => {}));
    }
  }

  async start(pageId?:string) {
    this.stop(); this.retryCount = 0;
    this.pageId=pageId;
    await this.connect(this.generation);
  }

  private async connect(generation: number) {
    const { deviceId, pack } = store.getState();
    if (!deviceId) return;
    const abort = new AbortController(); this.abort = abort; const pageId = this.pageId;
    store.setState({ phase: 'connecting', error: '' });
    try {
      const lease = await pageQueue(this.api, pageId).run(async () => {
        if (generation !== this.generation || abort.signal.aborted) return null;
        const created = await this.api.create(deviceId, pack, abort.signal, pageId);
        if (generation !== this.generation || abort.signal.aborted) {
          await boundedRelease(() => this.api.release(created.viewerId), this.releaseWaitMs);
          return null;
        }
        store.setState({ lease: created, phase: 'watching' });
        return created;
      });
      if (!lease || generation !== this.generation) return;
      this.scheduleRenew(lease, generation);
      await this.bootstrap(generation, true);
      if (generation === this.generation) this.subscribe(lease, generation);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }

  private fail(error: unknown) {
    if (error instanceof BmsApiError && [401, 403].includes(error.status)) {
      this.stop('unauthorized');
      if (error.status === 401) {
        store.setState({ identity: null });
        void this.api.session().catch(() => {});
      }
      store.setState({ error: error.message });
      if (error.status === 403 && error.code === 'DEVICE_FORBIDDEN') this.permissionRevoked?.(store.getState().deviceId);
      return;
    }
    this.scheduleReconnect(error);
  }

  private scheduleReconnect(error: unknown) {
    if (this.retryCount >= 8) {
      this.stop('expired');
      store.setState({ error: '自动重连已达8次，请检查网络后手动开始观测。' });
      return;
    }
    this.generation++;
    const generation = this.generation;
    this.cleanup('reconnecting');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5));
    store.setState({ error: error instanceof Error ? error.message : '实时连接中断，正在重连' });
    this.retry = setTimeout(() => { if (generation === this.generation) void this.connect(generation); }, delay);
  }

  private scheduleRenew(lease: ViewerLease, generation: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      const { pack } = store.getState();
      try {
        const renewed = await this.api.renew(lease.viewerId, pack);
        if (generation !== this.generation) return;
        store.setState({ lease: renewed }); this.scheduleRenew(renewed, generation);
      } catch (error) { if (generation === this.generation) this.fail(error); }
    }, lease.renewAfterSeconds * 1000);
  }

  private queryKey(metric: BmsMetric) {
    const { deviceId, pack } = store.getState();
    return `${deviceId}/${pack}/${metric}`;
  }

  private async loadTrend(metric: BmsMetric, generation: number, replace = false) {
    if (generation !== this.generation) return;
    const state = store.getState();
    if (!state.lease) return;
    const key = this.queryKey(metric);
    const requestKey = `${generation}/${key}`;
    if (this.fetching.has(requestKey)) return;
    if (this.queryKeys[metric] !== key) {
      this.queryKeys[metric] = key; this.trendCursors[metric] = null; replace = true;
    }
    this.fetching.add(requestKey);
    try {
      let cursor = replace ? null : (this.trendCursors[metric] ?? null);
      let firstPage = true;
      do {
        const page = await this.api.trend(state.deviceId, state.pack, metric, cursor);
        if (generation !== this.generation || key !== this.queryKey(metric)) return;
        store.getState().appendTrend(state.pack, metric, page.points, replace && firstPage);
        cursor = page.nextCursor;
        firstPage = false;
        if (!page.hasMore) break;
      } while (true);
      if (cursor) this.trendCursors[metric] = cursor;
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally { this.fetching.delete(requestKey); }
  }

  private async refreshTrends(generation: number, replace = false) {
    await Promise.all(BMS_METRICS.map(metric => this.loadTrend(metric, generation, replace)));
  }

  private async bootstrap(generation: number, includeHistory = false) {
    const { deviceId, pack } = store.getState();
    const latest = await this.api.latest(deviceId, pack);
    if (generation !== this.generation) return;
    store.setState({ devices: store.getState().devices.map((d) => d.deviceId === deviceId ? { ...d, online: latest.online, lastHeartbeatAt: latest.lastHeartbeatAt } : d), websiteConnected: true });
    for (const sample of latest.packs) store.getState().accept(sample);
    if (includeHistory) await this.refreshTrends(generation, true);
  }

  private subscribe(lease: ViewerLease, generation: number) {
    this.events?.close();
    const events = this.openEvents(`/api/realtime/events?viewerId=${encodeURIComponent(lease.viewerId)}`);
    this.events = events;
    events.onopen = () => {
      if (generation !== this.generation) return;
      this.retryCount = 0; store.setState({ phase: 'watching', websiteConnected: true, error: '' });
      // 补偿 bootstrap 与 SSE 建链之间完成的 Warm Start，避免错过 trend-backfill 事件。
      void this.refreshTrends(generation);
    };
    events.addEventListener('snapshot', (event) => {
      if (generation !== this.generation) return;
      try {
        store.getState().accept(JSON.parse((event as MessageEvent).data) as BmsSample);
        if (!this.trendRefresh) this.trendRefresh = setTimeout(() => { this.trendRefresh = undefined; void this.refreshTrends(generation); }, 1200);
      } catch { this.fail(new Error('收到无效的实时采样，请重新连接')); }
    });
    events.addEventListener('trend-backfill', () => {
      if (generation !== this.generation) return;
      if (!this.trendRefresh) this.trendRefresh = setTimeout(() => { this.trendRefresh = undefined; void this.refreshTrends(generation); }, 150);
    });
    events.addEventListener('device-status', (event) => {
      if (generation !== this.generation) return;
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data.viewing === false) { this.fail(new BmsApiError(410, 'VIEWER_EXPIRED', '观看租约结束，正在重新连接')); return; }
        store.setState({ devices: store.getState().devices.map((d) => d.deviceId === data.deviceId ? { ...d, online: data.online, lastHeartbeatAt: data.lastHeartbeatAt } : d) });
      } catch { this.fail(new Error('设备状态响应无效')); }
    });
    events.addEventListener('permission-revoked', (event) => {
      if (generation !== this.generation) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { deviceId?: string };
        const deviceId = store.getState().deviceId;
        if (!deviceId || data.deviceId !== deviceId) return;
        this.stop('unauthorized');
        store.setState({ error: '管理员已撤销此设备的观测权限。' });
        this.permissionRevoked?.(deviceId);
      } catch { this.fail(new Error('权限变更通知无效')); }
    });
    events.addEventListener('cache-status', (event) => { if (generation === this.generation) { try { store.setState({ cacheStatus: JSON.parse((event as MessageEvent).data) }); } catch {} } });
    events.addEventListener('cache-capacity', (event) => { if (generation === this.generation) { try { store.setState({ cacheStatus: JSON.parse((event as MessageEvent).data), capacityWarning: true }); } catch {} } });
    events.addEventListener('cache-cleared', () => {
      if (generation !== this.generation) return;
      this.trendCursors = {}; this.queryKeys = {};
      store.getState().clearData();
    });
    events.onerror = () => { if (generation === this.generation) this.scheduleReconnect(new Error('网站数据连接中断，正在重新申请观看租约')); };
  }
}
