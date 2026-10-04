import type { BmsDevice, BmsIdentity, BmsSample, BmsMetric, TrendPoint, ViewerLease, BmsSetupStatus, BmsRegistry, BmsDeviceCredential, MonitoringCacheStatus, MonitoringSystemAdmin, MonitoringSystemConfig, MonitoringSystemView } from './bmsRealtimeTypes';

export class BmsApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export interface TrendPage<T> { points: (T & { entryId: number })[]; nextCursor: string | null; hasMore: boolean }
let csrfToken = '';
export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
  const timeout = new AbortController();
  const abort = () => timeout.abort(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) timeout.abort();
  const timer = setTimeout(abort, 5000);
  try {
    const apiPath = path.startsWith('/experiment/') || path.startsWith('/monitoring/')
      ? `/api${path}`
      : `/api/realtime${path}`;
    const res = await fetch(apiPath, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: timeout.signal, keepalive,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Bms-Csrf': csrfToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = await res.json();
    if (!res.ok) throw new BmsApiError(res.status, data.error?.code ?? 'REQUEST_FAILED', data.error?.message ?? '实时服务请求失败');
    return data as T;
  } catch (e) {
    if (e instanceof BmsApiError) throw e;
    throw new BmsApiError(0, 'NETWORK_ERROR', '无法连接实时服务，请检查网络后重试');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const bmsApi = {
  setupStatus: () => request<BmsSetupStatus>('/setup/status'),
  async bootstrap(username: string, password: string, bootstrapToken: string) { await bmsApi.session(); const res = await request<{ user: BmsIdentity; csrfToken: string }>('/setup/bootstrap', 'POST', { username, password, bootstrapToken }); csrfToken = res.csrfToken; return res.user; },
  registry: () => request<BmsRegistry>('/admin/registry'),
  registerDevice: (device: { deviceId: string; alias: string; module?: 'bms' | 'experiment'; allowedPacks?: number[]; allowedAddresses?: number[]; allowedEquipment?: string[]; allowSimulation: boolean }) => request<BmsDeviceCredential>('/admin/devices', 'POST', device),
  registerUser: (username: string, password: string, devices: string[] = []) => request('/admin/users', 'POST', { username, password, devices }),
  deleteDevice: (id: string) => request<void>(`/admin/devices/${encodeURIComponent(id)}`, 'DELETE', { confirmDeviceId: id }),
  updateUser: (username: string, input: { devices: string[]; disabled: boolean }) => request<void>(`/admin/users/${encodeURIComponent(username)}`, 'PUT', input),
  resetUserPassword: (username: string, password: string) => request<void>(`/admin/users/${encodeURIComponent(username)}/password`, 'POST', { password }),
  rotateDevice: (id: string) => request<BmsDeviceCredential>(`/admin/devices/${encodeURIComponent(id)}/token`, 'POST', { confirmDeviceId: id }),
  getSystem: () => request<MonitoringSystemAdmin>('/monitoring/admin/system'),
  setSystem: (input: MonitoringSystemConfig) => request<{ system: MonitoringSystemConfig }>('/monitoring/admin/system', 'PUT', input),
  async session() { const res = await request<{ user: BmsIdentity | null; csrfToken: string }>('/auth/session'); csrfToken = res.csrfToken; return res.user; },
  async login(username: string, password: string) { await bmsApi.session(); const res = await request<{ user: BmsIdentity; csrfToken: string }>('/auth/login', 'POST', { username, password }); csrfToken = res.csrfToken; return res.user; },
  async logout() { await request('/auth/logout', 'POST'); csrfToken = ''; },
  devices: () => request<{ devices: BmsDevice[] }>('/devices'),
  create: (deviceId: string, pack: number, signal?: AbortSignal, pageId?:string) => request<ViewerLease>('/viewers', 'POST', { deviceId, packs: [pack], ...(pageId?{pageId}:{}) }, signal),
  renew: (id: string, pack: number) => request<ViewerLease>(`/viewers/${encodeURIComponent(id)}`, 'PUT', { packs: [pack] }),
  release: (id: string) => request<void>(`/viewers/${encodeURIComponent(id)}`, 'DELETE', undefined, undefined, true),
  latest: (deviceId: string, pack: number) => request<{ online: boolean; lastHeartbeatAt: string | null; packs: BmsSample[] }>(`/devices/${encodeURIComponent(deviceId)}/latest?packs=${pack}`),
  trend: (deviceId: string, pack: number, metric: BmsMetric, cursor?: string | null) => request<TrendPage<TrendPoint>>(`/devices/${encodeURIComponent(deviceId)}/trend?pack=${pack}&metric=${metric}&limit=2000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  clear: (deviceId: string) => request<void>(`/devices/${encodeURIComponent(deviceId)}/cache`, 'DELETE'),
};

export const monitoringApi = {
  devices: () => request<{ devices: BmsDevice[] }>('/monitoring/devices'),
  system: () => request<MonitoringSystemView>('/monitoring/system'),
  cache: () => request<MonitoringCacheStatus>('/monitoring/admin/cache'),
};
