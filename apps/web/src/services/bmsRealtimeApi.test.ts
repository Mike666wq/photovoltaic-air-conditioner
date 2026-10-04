import { afterEach, describe, expect, it, vi } from 'vitest';
import { bmsApi } from './bmsRealtimeApi';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('统一登录的 CSRF 会话初始化', () => {
  it('退出后无需刷新即可重新登录，并用新访客会话的 CSRF token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ user: null, csrfToken: 'initial-csrf' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ user: null, csrfToken: 'fresh-csrf' }))
      .mockResolvedValueOnce(json({ user: { username: 'observer', role: 'viewer', effectiveDeviceIds: ['bms-1'] }, csrfToken: 'logged-csrf' }));
    vi.stubGlobal('fetch', fetchMock);

    await bmsApi.session();
    await bmsApi.logout();
    const user = await bmsApi.login('observer', 'secret');

    expect(user.username).toBe('observer');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method ?? 'GET'])).toEqual([
      ['/api/realtime/auth/session', 'GET'],
      ['/api/realtime/auth/logout', 'POST'],
      ['/api/realtime/auth/session', 'GET'],
      ['/api/realtime/auth/login', 'POST'],
    ]);
    expect(new Headers(fetchMock.mock.calls[3][1]?.headers).get('X-Bms-Csrf')).toBe('fresh-csrf');
  });
});
