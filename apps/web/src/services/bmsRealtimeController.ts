import { bmsApi, BmsApiError } from './bmsRealtimeApi';
import { useBmsRealtimeStore as store } from '../store/bmsRealtime';
import { BMS_METRICS } from './bmsRealtimeTypes';
import type { BmsSample, ViewerLease } from './bmsRealtimeTypes';

/** 租约、重连和清理只在独立页面挂载后运行，其他路由没有实时副作用。 */
export class BmsRealtimeController {
  private generation = 0;
  private events: EventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | null = null;
  constructor(private api = bmsApi, private openEvents = (url: string) => new EventSource(url)) {}
  stop(phase: 'idle' | 'paused' | 'expired' | 'unauthorized' = 'idle') {
    this.generation++; this.abort?.abort(); this.abort = null;
    clearTimeout(this.timer); clearTimeout(this.retry); this.events?.close(); this.events = null;
    const lease = store.getState().lease;
    store.setState({ phase, lease: null, websiteConnected: false }); store.getState().clearData();
    if (lease) void this.api.release(lease.viewerId).catch(() => { /* 页面离开最终由TTL释放。 */ });
  }
  async start() {
    this.stop(); const generation = this.generation;
    const { deviceId, pack } = store.getState(); if (!deviceId) return;
    this.abort = new AbortController(); store.setState({ phase: 'connecting', error: '' });
    try {
      const lease = await this.api.create(deviceId, pack, this.abort.signal);
      if (generation !== this.generation) { void this.api.release(lease.viewerId).catch(() => {}); return; }
      store.setState({ lease, phase: 'watching' });
      this.scheduleRenew(lease, generation);
      await this.bootstrap(generation);
      if (generation === this.generation) this.subscribe(lease, generation);
    } catch (e) { if (generation === this.generation) this.fail(e); }
  }
  private fail(e: unknown) {
    const auth = e instanceof BmsApiError && [401, 403].includes(e.status);
    this.stop(auth ? 'unauthorized' : 'expired');
    if (e instanceof BmsApiError && e.status === 401) {
      store.setState({ identity: null });
      void this.api.session().catch(() => {});
    }
    store.setState({ error: e instanceof Error ? e.message : '实时数据连接失败' });
  }
  private scheduleRenew(lease: ViewerLease, generation: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      try {
        const renewed = await this.api.renew(lease.viewerId, store.getState().pack);
        if (generation !== this.generation) return;
        store.setState({ lease: renewed }); this.scheduleRenew(renewed, generation);
      } catch (e) {
        if (generation !== this.generation) return;
        // 已过期则显式重建；其他失败停止，避免失效EventSource无限重连。
        if (e instanceof BmsApiError && e.status === 410) { void this.start(); return; }
        this.fail(e);
      }
    }, lease.renewAfterSeconds * 1000);
  }
  private async bootstrap(generation: number) {
    const { deviceId, pack } = store.getState();
    const [latest, ...series] = await Promise.all([this.api.latest(deviceId, pack), ...BMS_METRICS.map((metric) => this.api.trend(deviceId, pack, metric))]);
    if (generation !== this.generation) return;
    const trends = { ...store.getState().trends };
    BMS_METRICS.forEach((metric, i) => { trends[metric] = (series[i] as { points: typeof trends.voltage }).points; });
    store.setState({ trends, devices: store.getState().devices.map((d) => d.deviceId === deviceId ? { ...d, online: latest.online, lastHeartbeatAt: latest.lastHeartbeatAt } : d), websiteConnected: true });
    for (const sample of latest.packs) store.getState().accept(sample);
  }
  private subscribe(lease: ViewerLease, generation: number) {
    this.events?.close();
    const events = this.openEvents(`/api/realtime/events?viewerId=${encodeURIComponent(lease.viewerId)}`); this.events = events;
    events.onopen = () => { if (generation === this.generation) store.setState({ phase: 'watching', websiteConnected: true, error: '' }); };
    events.addEventListener('snapshot', (event) => {
      if (generation !== this.generation) return;
      try { store.getState().accept(JSON.parse((event as MessageEvent).data) as BmsSample); }
      catch { this.fail(new Error('收到无效的实时采样，请重新连接')); }
    });
    events.addEventListener('device-status', (event) => {
      if (generation !== this.generation) return;
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data.viewing === false) { this.stop('expired'); return; }
        store.setState({ devices: store.getState().devices.map((d) => d.deviceId === data.deviceId ? { ...d, online: data.online, lastHeartbeatAt: data.lastHeartbeatAt } : d) });
      } catch { this.fail(new Error('设备状态响应无效')); }
    });
    events.addEventListener('cache-cleared', () => { if (generation === this.generation) store.getState().clearData(); });
    events.onerror = () => {
      if (generation !== this.generation) return;
      events.close(); store.setState({ phase: 'reconnecting', websiteConnected: false });
      clearTimeout(this.retry);
      this.retry = setTimeout(async () => {
        if (generation !== this.generation) return;
        try { await this.bootstrap(generation); if (generation === this.generation) this.subscribe(lease, generation); }
        catch (e) { if (generation === this.generation) this.fail(e); }
      }, 3000);
    };
  }
}
