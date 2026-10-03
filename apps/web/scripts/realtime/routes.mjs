import { loadConfig, validateConfig, tokenHash, equal, opaque, verifyPassword } from './auth.mjs';
import { RealtimeState } from './state.mjs';
import { ApiError, assert, object, identifier, packs, validateSnapshot } from './contract.mjs';

const PREFIX = '/api/realtime';
const COOKIE = 'bms_viewer';
export function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
// 对慢消费者限定Node写缓冲，不在应用层继续堆积快照。
export function writeSse(res, event, payload) {
  if (res.destroyed || res.writableEnded) return false;
  const packet = event ? `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n` : ': keepalive\n\n';
  if (res.writableLength + Buffer.byteLength(packet) > 65536) return false;
  res.write(packet); return true;
}
async function readJson(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 400, 'JSON_REQUIRED', '需要application/json正文');
  assert(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 400, 'ENCODING_UNSUPPORTED', '不支持压缩正文');
  assert(!req.headers['content-length'] || Number(req.headers['content-length']) <= 65536, 413, 'BODY_TOO_LARGE', '正文超过64KiB');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const body = await new Promise((resolve, reject) => {
    let text = ''; let size = 0;
    const finish = (error) => {
      clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', fail); req.removeListener('aborted', aborted);
      if (error) { req.resume(); reject(error); }
      else { try { resolve(text + decoder.decode()); } catch { reject(new ApiError(400, 'JSON_INVALID', 'JSON正文不是有效UTF-8')); } }
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > 65536) { finish(new ApiError(413, 'BODY_TOO_LARGE', '正文超过64KiB')); return; }
      try { text += decoder.decode(chunk, { stream: true }); } catch { finish(new ApiError(400, 'JSON_INVALID', 'JSON正文不是有效UTF-8')); }
    };
    const end = () => finish(); const fail = () => finish(new ApiError(400, 'BODY_INCOMPLETE', '请求正文不完整'));
    const aborted = fail;
    const timer = setTimeout(() => finish(new ApiError(400, 'BODY_TIMEOUT', '请求正文超时')), 4000); timer.unref();
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted);
  });
  let parsed; try { parsed = JSON.parse(body); } catch { throw new ApiError(400, 'JSON_INVALID', 'JSON正文无效'); }
  assert(object(parsed)); return parsed;
}
export function createRealtimeApi(options = {}) {
  const config = options.config ?? loadConfig();
  if (!config.enabled) return { handle: async (req, res) => { if (!(req.url === PREFIX || req.url?.startsWith(`${PREFIX}/`) || req.url?.startsWith(`${PREFIX}?`))) return false; json(res, 503, { error: { code: 'MODULE_DISABLED', message: '实时数据模块尚未启用，请联系管理员' } }); return true; }, close() {} };
  validateConfig(config);
  const state = new RealtimeState(config, options.clocks);
  const sessions = new Map(); const rates = new Map(); const streams = new Set(); let loginBusy = 0;
  function rate(key, maximum) {
    const now = state.now(); const entry = rates.get(key);
    if (!entry || entry.until <= now) {
      for (const [k, r] of rates) if (r.until <= now) rates.delete(k);
      assert(rates.size < 2000, 429, 'RATE_LIMITED', '请求过于频繁'); rates.set(key, { count: 1, until: now + 60000 }); return;
    }
    assert(entry.count < maximum, 429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'); entry.count++;
  }
  function cookie(res, id, maxAge = 28800) {
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/api/realtime; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.devHttp ? '' : '; Secure'}`);
  }
  function session(req, requireUser = true) {
    const id = (req.headers.cookie ?? '').split(';').map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const s = sessions.get(id);
    assert(s && s.until > state.now() && (!requireUser || s.user), 401, 'AUTH_REQUIRED', '请登录观看账户'); return { ...s, id };
  }
  function sameOrigin(req) {
    assert(req.headers.origin === config.publicOrigin && !['cross-site', 'none'].includes(req.headers['sec-fetch-site']), 403, 'ORIGIN_FORBIDDEN', '只允许网站同源操作');
  }
  function mutation(req, s) { sameOrigin(req); assert(equal(req.headers['x-bms-csrf'], s.csrf), 403, 'CSRF_INVALID', '请求验证失效，请刷新登录'); }
  function authorized(s, id) { assert(s.user.devices.includes(id), 403, 'DEVICE_FORBIDDEN', '没有此设备的观看权限'); return state.device(id).registration; }
  function deviceAuth(req) {
    const header = req.headers.authorization ?? '';
    assert(/^Bearer [a-zA-Z0-9_\-+/=]{32,256}$/.test(header), 401, 'DEVICE_AUTH_REQUIRED', '设备身份验证失败');
    const hash = tokenHash(header.slice(7)); const d = config.devices.find((v) => equal(v.deviceTokenHash, hash));
    if (!d) rate(`invalid-token:${req.socket.remoteAddress}`, 120);
    assert(d, 401, 'DEVICE_AUTH_REQUIRED', '设备身份验证失败'); return d;
  }
  function endStream(stream) { streams.delete(stream); if (!stream.res.writableEnded) stream.res.end(); }
  function write(stream, event, payload) {
    if (!writeSse(stream.res, event, payload)) endStream(stream);
  }
  state.listeners.add((type, deviceId, payload) => {
    for (const stream of streams) {
      const viewer = state.viewers.get(stream.viewerId);
      if (stream.deviceId !== deviceId) continue;
      if (type === 'viewer-ended' && stream.viewerId === payload.viewerId) {
        write(stream, 'device-status', { deviceId, viewing: false, code: 'VIEWER_EXPIRED' }); endStream(stream); continue;
      }
      if (!viewer || viewer.until <= state.now()) { endStream(stream); continue; }
      if (type === 'snapshot' && !viewer.packs.includes(payload.snapshot.pack)) continue;
      if (type !== 'viewer-ended') write(stream, type, payload);
    }
  });
  let lastKeepalive = state.now();
  const maintenance = setInterval(() => {
    state.sweep();
    for (const [id, s] of sessions) {
      if (s.until <= state.now()) { sessions.delete(id); for (const v of [...state.viewers.values()]) if (v.owner === id) state.release(v.viewerId, id); }
    }
    for (const stream of streams) if (!sessions.has(stream.owner)) endStream(stream);
    if (state.now() - lastKeepalive >= 15000) { lastKeepalive = state.now(); for (const stream of streams) write(stream); }
  }, 1000); maintenance.unref();

  async function route(req, res) {
    const url = new URL(req.url, 'http://internal'); const pathname = url.pathname.slice(PREFIX.length);
    if (pathname === '/heartbeat' && req.method === 'POST') {
      const d = deviceAuth(req); rate(`heartbeat:${d.deviceId}`, 30); const b = await readJson(req);
      assert(b.deviceId === d.deviceId, 403, 'DEVICE_MISMATCH', '设备身份不匹配');
      assert(typeof b.alias === 'string' && b.alias.length <= 128);
      return json(res, 200, state.heartbeat(d.deviceId));
    }
    if (pathname === '/snapshots' && req.method === 'POST') {
      const d = deviceAuth(req); rate(`snapshots:${d.deviceId}`, 1800); const b = await readJson(req);
      const snapshot = validateSnapshot(b, d); return json(res, 200, state.accept(d.deviceId, b.subscriptionId, snapshot));
    }
    if (pathname === '/auth/session' && req.method === 'GET') {
      rate(`session:${req.socket.remoteAddress}`, 120);
      let s;
      try { s = session(req, false); } catch {
        assert(sessions.size < 512, 429, 'SESSION_LIMIT', '观看会话数已达上限');
        const id = opaque(); s = { id, user: null, csrf: opaque(), until: state.now() + 300000 }; sessions.set(id, s); cookie(res, id, 300);
      }
      return json(res, 200, { user: s.user ? { username: s.user.username, role: s.user.role ?? 'viewer' } : null, csrfToken: s.csrf });
    }
    if (pathname === '/auth/login' && req.method === 'POST') {
      const s = session(req, false); mutation(req, s); rate(`login:${req.socket.remoteAddress}`, 10);
      const b = await readJson(req); assert(typeof b.username === 'string' && b.username.length <= 80 && typeof b.password === 'string' && b.password.length <= 256);
      assert(loginBusy < 4, 429, 'LOGIN_BUSY', '请稍后再登录');
      const user = config.users.find((u) => u.username === b.username); let ok;
      loginBusy++; try { ok = await verifyPassword(b.password, (user ?? config.users[0]).passwordHash); } finally { loginBusy--; }
      assert(user && ok, 401, 'LOGIN_FAILED', '用户名或密码不正确');
      for (const v of [...state.viewers.values()]) if (v.owner === s.id) state.release(v.viewerId, s.id);
      sessions.delete(s.id); const id = opaque(); const logged = { user, csrf: opaque(), until: state.now() + 28800000 }; sessions.set(id, logged); cookie(res, id);
      return json(res, 200, { user: { username: user.username, role: user.role ?? 'viewer' }, csrfToken: logged.csrf });
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      const s = session(req); mutation(req, s); sessions.delete(s.id);
      for (const v of [...state.viewers.values()]) if (v.owner === s.id) state.release(v.viewerId, s.id);
      for (const stream of streams) if (stream.owner === s.id) endStream(stream);
      cookie(res, '', 0); return json(res, 204);
    }
    // 未知API永远返回JSON，不交给SPA fallback（也不重定向到登录页）。
    if (!['/devices', '/viewers', '/events'].includes(pathname) && !/^\/(?:viewers\/[^/]+|devices\/[^/]+\/(?:latest|trend|cache))$/.test(pathname)) throw new ApiError(404, 'NOT_FOUND', '实时接口不存在');
    const s = session(req);
    rate(`browser:${s.user.username}`, 600);
    if (pathname === '/devices' && req.method === 'GET') {
      state.sweep(); return json(res, 200, { devices: s.user.devices.map((id) => state.info(state.device(id))) });
    }
    if (pathname === '/viewers' && req.method === 'POST') {
      mutation(req, s); const b = await readJson(req); const d = authorized(s, b.deviceId);
      return json(res, 201, state.createViewer(s.id, d.deviceId, packs(b.packs, d.allowedPacks), s.user.username));
    }
    const viewerMatch = pathname.match(/^\/viewers\/([^/]+)$/);
    if (viewerMatch && ['PUT', 'DELETE'].includes(req.method)) {
      mutation(req, s); const id = viewerMatch[1];
      if (req.method === 'DELETE') { state.release(id, s.id); return json(res, 204); }
      const v = state.viewer(id, s.id); const d = authorized(s, v.deviceId); const b = await readJson(req);
      return json(res, 200, state.renew(id, s.id, packs(b.packs, d.allowedPacks)));
    }
    const deviceMatch = pathname.match(/^\/devices\/([^/]+)\/(latest|trend|cache)$/);
    if (deviceMatch) {
      const [, id, resource] = deviceMatch; const d = authorized(s, id);
      if (resource === 'latest' && req.method === 'GET') {
        const selected = url.searchParams.has('packs') ? packs(url.searchParams.get('packs').split(',').map(Number), d.allowedPacks) : d.allowedPacks;
        return json(res, 200, state.latest(id, selected));
      }
      if (resource === 'trend' && req.method === 'GET') {
        const pack = packs([Number(url.searchParams.get('pack'))], d.allowedPacks)[0];
        const limit = Number(url.searchParams.get('limit') ?? 600); assert(Number.isInteger(limit) && limit >= 1 && limit <= 600);
        return json(res, 200, state.trend(id, pack, url.searchParams.get('metric'), limit));
      }
      if (resource === 'cache' && req.method === 'DELETE') {
        mutation(req, s); assert(s.user.role === 'admin', 403, 'ADMIN_REQUIRED', '只有管理员可以清理缓存'); state.clear(id); return json(res, 204);
      }
    }
    if (pathname === '/events' && req.method === 'GET') {
      const id = url.searchParams.get('viewerId'); assert(identifier(id));
      const v = state.viewer(id, s.id); authorized(s, v.deviceId);
      assert([...streams].filter((e) => e.owner === s.id || e.username === s.user.username).length < 4, 429, 'SSE_LIMIT', '实时订阅连接数已达上限');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' }); res.flushHeaders();
      const stream = { res, viewerId: id, deviceId: v.deviceId, owner: s.id, username: s.user.username }; streams.add(stream);
      res.on('close', () => streams.delete(stream)); write(stream, 'device-status', state.info(state.device(v.deviceId)));
      for (const item of state.latest(v.deviceId, v.packs).packs) write(stream, 'snapshot', item);
      return;
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法');
  }
  return {
    state,
    async handle(req, res) {
      if (!(req.url === PREFIX || req.url?.startsWith(`${PREFIX}/`) || req.url?.startsWith(`${PREFIX}?`))) return false;
      try { await route(req, res); } catch (error) {
        if (res.headersSent) { res.destroy(); return true; }
        const safe = error instanceof ApiError ? error : new ApiError(503, 'SERVICE_UNAVAILABLE', '实时服务暂不可用');
        if (safe.status === 413 || safe.code === 'BODY_TIMEOUT') res.setHeader('Connection', 'close');
        json(res, safe.status, { error: { code: safe.code, message: safe.message } });
      }
      return true;
    },
    close() { clearInterval(maintenance); for (const stream of streams) endStream(stream); state.listeners.clear(); },
  };
}
