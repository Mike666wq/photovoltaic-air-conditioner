import { loadConfig, validateConfig, tokenHash, equal, opaque, verifyPassword, passwordHash } from './auth.mjs';
import { RegistryStore } from './registry.mjs';
import { CacheCoordinator } from './cache-coordinator.mjs';
import { setupStatus, accountInput, registerDevice, registerUser, rotateDevice, refreshDevice, deleteDevice, updateUserDevices, updateUserMonitoring, resetUserPassword } from './registration.mjs';
import { RealtimeState } from './state.mjs';
import { ExperimentState } from './experiment-state.mjs';
import { catalog, equipment, historyPoints, validateExperimentSnapshot, validateExperimentBackfill } from './experiment-contract.mjs';
import { ApiError, assert, object, identifier, packs, validateSnapshot, validateBmsBackfill } from './contract.mjs';
import { TRANSPORT, HEARTBEAT, DEVICE_PREFIX, DEVICE_STATE, ENROLLMENT, sanitizeClientReport, validateClaimRequest, isMachineKey } from './base-contract.mjs';
import { ClaimStore } from './claim.mjs';

const PREFIX = '/api/realtime';
const COOKIE = 'cloud_viewer';
// /api/device 是模块无关的接入前缀：认领发生在「还没有设备令牌」的时候，
// 不能塞进上面三个业务前缀（它们每个端点都要求 Bearer 令牌）。
const apiPrefix=(url)=>['/api/monitoring','/api/experiment',DEVICE_PREFIX,PREFIX].find(p=>url===p||url?.startsWith(p+'/')||url?.startsWith(p+'?'));
const moduleOf=(device)=>device.module??'bms';
function sourceFilter(value) { assert(value == null || ['serial','simulation'].includes(value),400,'SOURCE_INVALID','数据来源无效'); return value ?? null; }
function trendLimit(url) { const limit=Number(url.searchParams.get('limit')??2000); assert(Number.isInteger(limit)&&limit>=1&&limit<=2000,400,'LIMIT_INVALID','每页最多2000个趋势点'); return limit; }
export function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
// 对慢消费者限定Node写缓冲，不在应用层继续堆积快照。
export function writeSse(res, event, payload) {
  if (res.destroyed || res.writableEnded) return false;
  const packet = event ? `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n` : ': keepalive\n\n';
  if (res.writableLength + Buffer.byteLength(packet) > TRANSPORT.responseMaxBytes) return false;
  res.write(packet); return true;
}
async function readJson(req, maxBytes = TRANSPORT.responseMaxBytes) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 400, 'JSON_REQUIRED', '需要application/json正文');
  assert(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 400, 'ENCODING_UNSUPPORTED', '不支持压缩正文');
  assert(!req.headers['content-length'] || Number(req.headers['content-length']) <= maxBytes, 413, 'BODY_TOO_LARGE', `正文超过${Math.floor(maxBytes / 1024)}KiB`);
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
      if (size > maxBytes) { finish(new ApiError(413, 'BODY_TOO_LARGE', `正文超过${Math.floor(maxBytes / 1024)}KiB`)); return; }
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
  if (!config.enabled) return { handle: async (req, res) => { if (!apiPrefix(req.url)) return false; if (req.url === `${apiPrefix(req.url)}/setup/status` && req.method === 'GET') json(res, 200, setupStatus(config)); else json(res, 503, { error: { code: 'MODULE_DISABLED', message: '实时数据模块尚未启用，请联系管理员' } }); return true; }, close() {} };
  validateConfig(config);
  const coordinator = options.coordinator ?? new CacheCoordinator(config, options.clocks);
  const state = new RealtimeState({...config,maxViewerLeases:config.maxViewerLeases??40,coordinator,devices:config.devices.filter(d=>moduleOf(d)==='bms')}, options.clocks);
  const experiment = new ExperimentState({...config,maxViewerLeases:config.maxViewerLeases??40,coordinator,devices:config.devices.filter(d=>moduleOf(d)==='experiment')},options.clocks);
  const states=[state,experiment];
  // 认领存储：与 registry.json 分开放，避免半成品的 pending 记录触发 validateConfig 的逐条断言。
  const claims = new ClaimStore(config, options.clocks);
  const boundLegacyIds = (systemConfig) => [systemConfig?.experimentDeviceId, systemConfig?.bmsDeviceId].filter(Boolean);
  const effectiveDeviceIds = (user, systemConfig = config.system, devices = config.devices) => {
    // 墓碑对「实时观测」不可见：设备已经删了，不该出现在观看列表里。
    const available = new Set(devices.filter(d => (d.state ?? 'active') !== 'revoked').map(d => d.deviceId));
    if (user.role === 'admin') return [...available];
    const ids = new Set((user.devices ?? []).filter(id => available.has(id)));
    if (user.monitoringAccess) for (const id of boundLegacyIds(systemConfig)) if (available.has(id)) ids.add(id);
    return [...ids];
  };
  let boundSystem = structuredClone(config.system);
  let boundUsers = structuredClone(config.users), boundDevices = structuredClone(config.devices);
  const sessions = new Map(); const rates = new Map(); const streams = new Set(); let loginBusy = 0;
  const registry = new RegistryStore(config, (devices, systemConfig, users) => {
    try {
      const before = boundSystem ?? {};
      for (const oldUser of boundUsers) {
        if (oldUser.role === 'admin' || oldUser.disabled) continue;
        const current = users.find(u => u.username === oldUser.username);
        const oldIds = new Set(effectiveDeviceIds(oldUser, before, boundDevices));
        const nextIds = new Set(current && !current.disabled ? effectiveDeviceIds(current, systemConfig, devices) : []);
        for (const id of oldIds) if (!nextIds.has(id)) {
          for (const target of states) for (const viewer of [...target.viewers.values()]) {
            if (viewer.principal !== oldUser.username || viewer.deviceId !== id) continue;
            for (const stream of [...streams]) if (stream.viewerId === viewer.viewerId) {
              write(stream, 'permission-revoked', { deviceId: id, code: 'DEVICE_PERMISSION_REVOKED' });
              endStream(stream);
            }
          }
        }
      }
      state.syncRegistrations(devices.filter(d=>moduleOf(d)==='bms')); experiment.syncRegistrations(devices.filter(d=>moduleOf(d)==='experiment'));
      boundSystem = structuredClone(systemConfig);
      for (const [id, s] of sessions) {
        const current = users.find(u => u.username === s.user?.username);
        if (s.user && (!current || current.disabled || current.passwordHash !== s.user.passwordHash)) {
          sessions.delete(id); for (const target of states) for (const v of [...target.viewers.values()]) if (v.owner === id) target.release(v.viewerId, id);
          for (const stream of streams) if (stream.owner === id) endStream(stream);
        }
      }
      for (const target of states) for (const v of [...target.viewers.values()]) {
        const current = users.find(u => u.username === v.principal);
        if (!current || current.disabled || !effectiveDeviceIds(current, systemConfig, devices).includes(v.deviceId)) target.release(v.viewerId, v.owner);
      }
      boundUsers = structuredClone(users); boundDevices = structuredClone(devices);
    } catch {
      // 文件已提交；运行态同步失败时撤销全部观看，避免旧授权继续推送。
      sessions.clear();
      for (const stream of [...streams]) endStream(stream);
      streams.clear();
      for (const target of states) {
        target.viewers.clear();
        for (const device of target.devices.values()) { device.lease = null; device.latest.clear(); device.rings.clear(); device.watermarks.clear(); device.sequences.clear(); }
      }
      boundSystem = structuredClone(systemConfig); boundUsers = structuredClone(users); boundDevices = structuredClone(devices);
      console.error('[realtime] 注册提交后的运行态同步失败，已关闭全部观看会话');
    }
  });
  const registeredInfo=(d)=>{const target=moduleOf(d)==='experiment'?experiment:state;return {...target.info(target.device(d.deviceId)),module:moduleOf(d)};};
  function rate(key, maximum) {
    const now = state.now(); const entry = rates.get(key);
    if (!entry || entry.until <= now) {
      for (const [k, r] of rates) if (r.until <= now) rates.delete(k);
      assert(rates.size < 2000, 429, 'RATE_LIMITED', '请求过于频繁'); rates.set(key, { count: 1, until: now + 60000 }); return;
    }
    assert(entry.count < maximum, 429, 'RATE_LIMITED', '请求过于频繁，请稍后重试'); entry.count++;
  }
  function activeViewers() {
    for (const target of states) target.sweep();
    return states.flatMap(target => [...target.viewers.values()].filter(v => v.until > state.now()).map(viewer => ({ target, viewer })));
  }
  function pageIdInput(body) {
    if (!Object.hasOwn(body, 'pageId')) return opaque(); // 旧客户端每条租约按独立页面计数。
    assert(typeof body.pageId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.pageId), 400, 'PAGE_ID_INVALID', '页面标识无效');
    return body.pageId;
  }
  function cookie(res, id, maxAge = 28800) {
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.devHttp ? '' : '; Secure'}`);
  }
  function session(req, requireUser = true) {
    const id = (req.headers.cookie ?? '').split(';').map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const s = sessions.get(id); const user = s?.user ? config.users.find((u) => u.username === s.user.username) : null;
    assert(s && s.until > state.now() && (!requireUser || (user && !user.disabled && s.user.passwordHash === user.passwordHash)), 401, 'AUTH_REQUIRED', '请登录观看账户'); return { ...s, user, id };
  }
  function sameOrigin(req) {
    assert(req.headers.origin === config.publicOrigin && !['cross-site', 'none'].includes(req.headers['sec-fetch-site']), 403, 'ORIGIN_FORBIDDEN', '只允许网站同源操作');
  }
  function mutation(req, s) { sameOrigin(req); assert(equal(req.headers['x-bms-csrf'], s.csrf), 403, 'CSRF_INVALID', '请求验证失效，请刷新登录'); }
  function loggedResponse(res, s, user, status = 200) {
    for (const target of states) for (const v of [...target.viewers.values()]) if (v.owner === s.id) target.release(v.viewerId, s.id);
    sessions.delete(s.id); const id = opaque(); const logged = { user, csrf: opaque(), until: state.now() + 28800000 }; sessions.set(id, logged); cookie(res, id);
    return json(res, status, { user: { username: user.username, role: user.role ?? 'viewer', monitoringAccess: user.role === 'admin' || !!user.monitoringAccess, effectiveDeviceIds: effectiveDeviceIds(user) }, csrfToken: logged.csrf });
  }
  function authorized(s, id, target) {
    assert(effectiveDeviceIds(s.user).includes(id) && target.devices.has(id),403,'DEVICE_FORBIDDEN','没有此模块设备的观看权限');
    return target.device(id).registration;
  }
  function deviceAuth(req, module) {
    const header = req.headers.authorization ?? '';
    assert(/^Bearer [a-zA-Z0-9_\-+/=]{32,256}$/.test(header), 401, 'DEVICE_AUTH_REQUIRED', '设备身份验证失败');
    const hash = tokenHash(header.slice(7)); const d = config.devices.find((v) => equal(v.deviceTokenHash, hash));
    if (!d) rate(`invalid-token:${req.socket.remoteAddress}`, 120);
    assert(d, 401, 'DEVICE_AUTH_REQUIRED', '设备身份验证失败'); assert(moduleOf(d)===module,403,'MODULE_FORBIDDEN','设备令牌不属于此模块');
    // 还没走完接入确认的设备不许发业务请求；revoked 保留可达，否则指令送不到。
    const deviceState = d.state ?? DEVICE_STATE.active;
    assert(deviceState !== DEVICE_STATE.pending && deviceState !== DEVICE_STATE.approved, 403, 'DEVICE_NOT_ACTIVE', '设备尚未完成接入确认');
    return d;
  }
  function endStream(stream) { streams.delete(stream); if (!stream.res.writableEnded) stream.res.end(); }
  function write(stream, event, payload) {
    if (!writeSse(stream.res, event, payload)) endStream(stream);
  }
  let lastCacheStatusAt = -Infinity;
  coordinator.onChange((cacheStatus) => {
    const now = state.now(); if (now - lastCacheStatusAt < 5000) return; lastCacheStatusAt = now;
    for (const stream of streams) write(stream, 'cache-status', cacheStatus);
  });
  for(const target of states) target.listeners.add((type, deviceId, payload) => {
    for (const stream of streams) {
      const viewer = target.viewers.get(stream.viewerId);
      if (stream.target !== target || stream.deviceId !== deviceId) continue;
      if (type === 'viewer-ended' && stream.viewerId === payload.viewerId) {
        const endedStatus = { deviceId, viewing: false, code: 'VIEWER_EXPIRED' };
        if (target === experiment) endedStatus.uploadStatus = target.getUploadStatus(deviceId);
        write(stream, 'device-status', endedStatus); endStream(stream); continue;
      }
      if (!viewer || viewer.until <= state.now()) { endStream(stream); continue; }
      if (type === 'snapshot' && (!viewer.packs.includes(target===experiment?payload.snapshot.equipmentId:payload.snapshot.pack) || (stream.source && stream.source !== payload.snapshot.source))) continue;
      if (type !== 'viewer-ended') {
        const eventPayload = target === experiment && type === 'device-status' ? { ...payload, uploadStatus: target.getUploadStatus(deviceId) } : payload;
        write(stream, type, eventPayload);
      }
    }
  });
  let lastKeepalive = state.now();
  const maintenance = setInterval(() => {
    for(const target of states) target.sweep();
    for (const [id, s] of sessions) {
      if (s.until <= state.now()) { sessions.delete(id); for(const target of states) for (const v of [...target.viewers.values()]) if (v.owner === id) target.release(v.viewerId, id); }
    }
    for (const stream of streams) if (!sessions.has(stream.owner)) endStream(stream);
    if (state.now() - lastKeepalive >= 15000) { lastKeepalive = state.now(); for (const stream of streams) write(stream); }
  }, 1000); maintenance.unref();

  // ─────────── 设备接入（/api/device，模块无关） ───────────
  function bearer(req) {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    return match ? match[1] : '';
  }
  function numbersList(values, max) {
    assert(Array.isArray(values) && values.length > 0 && values.length <= 16 && values.every((v) => Number.isInteger(v) && v >= 1 && v <= max), 400, 'REGISTRATION_RANGE_INVALID', '地址或 Pack 范围无效');
    return [...new Set(values)].sort((a, b) => a - b);
  }
  function claimView(record) {
    return {
      claimId: record.claimId,
      state: record.state,
      pollIntervalSec: ENROLLMENT.pollIntervalSec,
      expiresAtUtc: record.expiresAtUtc,
      serverTimeUtc: new Date(state.wall()).toISOString(),
      message: record.state === 'pending' ? '等待管理员在设备管理页批准' : undefined,
    };
  }
  function pendingView(record) {
    return {
      claimId: record.claimId,
      machineKey: record.machineKey,
      module: record.module,
      desiredAlias: record.desiredAlias || null,
      client: record.client ?? null,
      createdAtUtc: record.createdAtUtc,
      expiresAtUtc: record.expiresAtUtc,
    };
  }
  function publicDevice(d) {
    return {
      deviceId: d.deviceId, alias: d.alias, module: moduleOf(d),
      state: d.state ?? 'active',
      machineKey: d.machineKey ?? null,
      configVersion: d.configVersion ?? 1,
      allowedPacks: d.allowedPacks ?? [], allowedAddresses: d.allowedAddresses ?? [],
      allowedEquipment: d.allowedEquipment ?? null,
      allowSimulation: d.allowSimulation === true,
      statusReason: d.statusReason ?? '', changedBy: d.changedBy ?? null, changedAtUtc: d.changedAtUtc ?? null,
      lastRotatedAt: d.lastRotatedAt ?? null,
    };
  }

  async function routeDevice(req, res, pathname) {
    // —— 设备侧：只认 claimSecret / deviceToken，不认浏览器会话 ——
    if (pathname === '/claim' && req.method === 'POST') {
      rate(`claim-ip:${req.socket.remoteAddress}`, ENROLLMENT.claimRatePerMinute);
      const secret = bearer(req);
      assert(secret && secret.length >= ENROLLMENT.secretLenMin && secret.length <= ENROLLMENT.secretLenMax, 401, 'CLAIM_SECRET_INVALID', '认领凭据无效');
      const b = await readJson(req);
      if (!isMachineKey(b?.machineKey)) assert(false, 400, 'MACHINE_KEY_INVALID', '机器钥匙格式无效');
      rate(`claim-key:${b.machineKey}`, ENROLLMENT.claimRatePerKeyPerMinute);
      const errors = validateClaimRequest(b);
      assert(errors.length === 0, 400, 'CLAIM_INVALID', errors[0]);
      const record = await claims.create({
        machineKey: b.machineKey, module: b.module, claimSecret: secret,
        desiredAlias: b.desiredAlias, client: sanitizeClientReport(b.client),
      });
      const view = claimView(record);
      // 已批准且令牌还没被取走：把令牌连同配置一起交付（一次性）。
      if (record.state === 'approved') {
        const grant = await claims.takeGrant(record.grantId);
        if (grant) {
          const device = config.devices.find((d) => d.deviceId === grant.deviceId);
          if (device) Object.assign(view, {
            state: 'approved', deviceId: device.deviceId, deviceToken: grant.deviceToken,
            configVersion: device.configVersion ?? 1, config: configOf(device),
          });
        } else view.tokenDelivered = true;
      }
      if (record.state === 'rejected') view.reason = record.rejectedReason;
      return json(res, 201, view);
    }

    const claimStatus = pathname.match(/^\/claim\/([^/]+)$/);
    if (claimStatus && req.method === 'POST') {
      const secret = bearer(req);
      assert(secret, 401, 'CLAIM_SECRET_INVALID', '认领凭据无效');
      rate(`claim-poll:${claimStatus[1]}`, 30);
      const record = await claims.auth(claimStatus[1], secret);
      const view = claimView(record);
      if (record.state === 'approved') {
        const grant = await claims.takeGrant(record.grantId);
        if (grant) {
          const device = config.devices.find((d) => d.deviceId === grant.deviceId);
          if (device) Object.assign(view, {
            deviceId: device.deviceId, deviceToken: grant.deviceToken,
            configVersion: device.configVersion ?? 1, config: configOf(device),
          });
        } else view.tokenDelivered = true;
      }
      if (record.state === 'rejected') view.reason = record.rejectedReason;
      return json(res, 200, view);
    }

    if (pathname === '/ack' && req.method === 'POST') {
      const secret = bearer(req);
      assert(secret, 401, 'CLAIM_SECRET_INVALID', '认领凭据无效');
      const b = await readJson(req);
      assert(b && typeof b.claimId === 'string' && b.persisted === true, 400, 'ACK_INVALID', '必须在本地落盘成功后再确认');
      rate(`claim-ack:${b.claimId}`, 20);
      const record = await claims.auth(b.claimId, secret);
      assert(record.state === 'approved' || record.state === 'active', 409, 'STATE_CONFLICT', '认领尚未批准或已失效');
      const device = config.devices.find((d) => d.deviceId === record.deviceId);
      assert(device, 404, 'DEVICE_NOT_FOUND', '设备不存在');
      if (record.state === 'approved') {
        await registry.mutate((next) => {
          const target = next.devices.find((d) => d.deviceId === record.deviceId);
          assert(target, 404, 'DEVICE_NOT_FOUND', '设备不存在');
          target.state = DEVICE_STATE.active;
          target.ackedAtUtc = new Date(state.wall()).toISOString();
          target.configVersion = target.configVersion ?? 1;
        });
        await claims.remove(record.claimId);
      }
      return json(res, 200, {
        state: DEVICE_STATE.active, deviceId: device.deviceId,
        configVersion: device.configVersion ?? 1,
        heartbeatIntervalSec: HEARTBEAT.intervalSeconds,
        serverTimeUtc: new Date(state.wall()).toISOString(),
      });
    }

    // —— 管理侧：浏览器会话 + 管理员 + CSRF ——
    assert(pathname.startsWith('/admin/'), 404, 'NOT_FOUND', '接入接口不存在');
    const s = session(req);
    assert(s.user.role === 'admin', 403, 'ADMIN_REQUIRED', '只有管理员可以管理设备接入');
    rate(`device-admin:${s.user.username}`, 120);

    if (pathname === '/admin/claims' && req.method === 'GET') {
      const list = await claims.listPending();
      return json(res, 200, { claims: list.map(pendingView), pendingLimit: claims.maxPending });
    }

    const approveMatch = pathname.match(/^\/admin\/claims\/([^/]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      mutation(req, s);
      const b = await readJson(req);
      const record = await claims.byClaimId(approveMatch[1]);
      assert(record, 404, 'CLAIM_NOT_FOUND', '认领不存在或已过期');
      assert(record.state === 'pending', 409, 'STATE_CONFLICT', '该认领已处理');
      const deviceId = (typeof b.deviceId === 'string' && b.deviceId.trim()) || record.machineKey;
      assert(/^[A-Za-z0-9_-]{1,80}$/.test(deviceId), 400, 'DEVICE_ID_INVALID', '设备编号只能包含字母、数字、下划线或短横线');
      const module = record.module;
      const alias = (typeof b.alias === 'string' && b.alias.trim()) || record.desiredAlias || `设备 ${deviceId.slice(-6)}`;
      const permissions = module === 'experiment'
        ? { allowedEquipment: equipment(b.allowedEquipment, undefined) }
        : { allowedPacks: numbersList(b.allowedPacks, 16), allowedAddresses: numbersList(b.allowedAddresses ?? [1], 255) };
      const deviceToken = opaque();
      const created = await registry.mutate((next) => {
        assert(!next.devices.some((d) => d.deviceId === deviceId), 409, 'DEVICE_EXISTS', '设备编号已存在');
        assert(next.devices.filter((d) => DEVICE_STATE.billable.includes(d.state ?? 'active')).length < (config.maxDevices ?? 20), 409, 'DEVICE_LIMIT', '已注册设备数达到上限');
        const device = {
          deviceId, alias: alias.trim().slice(0, 128), module, ...permissions,
          deviceTokenHash: tokenHash(deviceToken), allowSimulation: b.allowSimulation === true,
          displayTimeZone: 'Asia/Shanghai',
          state: DEVICE_STATE.approved, machineKey: record.machineKey,
          configVersion: 1, enrolledVia: 'claim', protocolVersion: ENROLLMENT.protocolVersion,
          approvedAtUtc: new Date(state.wall()).toISOString(), changedBy: s.user.username,
          changedAtUtc: new Date(state.wall()).toISOString(), statusReason: b.note ?? '',
        };
        next.devices.push(device);
        return device;
      });
      const { grantId } = await claims.approve(record.claimId, { deviceId, deviceToken, configVersion: 1 });
      return json(res, 201, { claimId: record.claimId, deviceId, state: DEVICE_STATE.approved, configVersion: 1, grantId });
    }

    const rejectMatch = pathname.match(/^\/admin\/claims\/([^/]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      mutation(req, s);
      const b = await readJson(req);
      const record = await claims.reject(rejectMatch[1], b?.reason);
      return json(res, 200, { claimId: record.claimId, state: record.state, reason: record.rejectedReason });
    }

    if (pathname === '/admin/devices' && req.method === 'GET') {
      return json(res, 200, { devices: config.devices.map(publicDevice) });
    }

    const deviceMatch = pathname.match(/^\/admin\/devices\/([^/]+)$/);
    if (deviceMatch && req.method === 'PUT') {
      mutation(req, s);
      const b = await readJson(req);
      const updated = await registry.mutate((next) => {
        const target = next.devices.find((d) => d.deviceId === deviceMatch[1]);
        assert(target, 404, 'DEVICE_NOT_FOUND', '设备不存在');
        if (b.expectedConfigVersion != null) assert((target.configVersion ?? 1) === b.expectedConfigVersion, 409, 'STATE_CONFLICT', '配置已被其他人修改，请刷新后重试');
        if (typeof b.alias === 'string' && b.alias.trim()) target.alias = b.alias.trim().slice(0, 128);
        if (moduleOf(target) === 'experiment') { if (b.allowedEquipment !== undefined) target.allowedEquipment = equipment(b.allowedEquipment, undefined); }
        else { if (b.allowedPacks !== undefined) target.allowedPacks = numbersList(b.allowedPacks, 16); if (b.allowedAddresses !== undefined) target.allowedAddresses = numbersList(b.allowedAddresses, 255); }
        if (typeof b.allowSimulation === 'boolean') target.allowSimulation = b.allowSimulation;
        if (typeof b.note === 'string') target.statusReason = b.note.slice(0, 200);
        target.configVersion = (target.configVersion ?? 1) + 1;
        target.changedBy = s.user.username;
        target.changedAtUtc = new Date(state.wall()).toISOString();
        return publicDevice(target);
      });
      return json(res, 200, updated);
    }

    const actionMatch = pathname.match(/^\/admin\/devices\/([^/]+)\/(suspend|resume|rekey)$/);
    if (actionMatch && req.method === 'POST') {
      mutation(req, s);
      const [, deviceId, action] = actionMatch;
      const b = await readJson(req).catch(() => ({}));
      if (action === 'rekey') {
        const deviceToken = opaque();
        await registry.mutate((next) => {
          const target = next.devices.find((d) => d.deviceId === deviceId);
          assert(target, 404, 'DEVICE_NOT_FOUND', '设备不存在');
          target.deviceTokenHash = tokenHash(deviceToken);
          target.lastRotatedAt = new Date(state.wall()).toISOString();
          target.configVersion = (target.configVersion ?? 1) + 1;
        });
        return json(res, 200, { deviceId, deviceToken });
      }
      const nextState = action === 'suspend' ? DEVICE_STATE.suspended : DEVICE_STATE.active;
      const updated = await registry.mutate((next) => {
        const target = next.devices.find((d) => d.deviceId === deviceId);
        assert(target, 404, 'DEVICE_NOT_FOUND', '设备不存在');
        assert((target.state ?? 'active') !== DEVICE_STATE.revoked, 409, 'STATE_CONFLICT', '设备已删除，需重新认领');
        target.state = nextState;
        target.configVersion = (target.configVersion ?? 1) + 1;
        target.statusReason = typeof b.reason === 'string' ? b.reason.slice(0, 200) : '';
        target.changedBy = s.user.username;
        target.changedAtUtc = new Date(state.wall()).toISOString();
        return publicDevice(target);
      });
      return json(res, 200, updated);
    }

    if (deviceMatch && req.method === 'DELETE') {
      mutation(req, s);
      const b = await readJson(req).catch(() => ({}));
      const updated = await registry.mutate((next) => {
        const target = next.devices.find((d) => d.deviceId === deviceMatch[1]);
        assert(target, 404, 'DEVICE_NOT_FOUND', '设备不存在');
        // 写墓碑而不是立即从数组删除：立即删会让设备心跳拿到 401，
        // 而客户端对 401 有自动续期逻辑，会变成无限重试。
        target.state = DEVICE_STATE.revoked;
        target.configVersion = (target.configVersion ?? 1) + 1;
        target.statusReason = typeof b.reason === 'string' ? b.reason.slice(0, 200) : '设备已删除';
        target.purgeAfterUtc = new Date(state.wall() + ENROLLMENT.tombstoneHours * 3600000).toISOString();
        target.allowReclaim = b.allowReclaim === true;
        target.changedBy = s.user.username;
        target.changedAtUtc = new Date(state.wall()).toISOString();
        for (const user of next.users) user.devices = (user.devices ?? []).filter((id) => id !== target.deviceId);
        return publicDevice(target);
      });
      return json(res, 200, updated);
    }

    throw new ApiError(404, 'NOT_FOUND', '接入接口不存在');
  }

  /**
   * 停用/删除时下发的指令。用显式命令而不是 401 —— 客户端对 401 有自动续期逻辑，
   * 而续期端点同样要鉴权，会变成「401 → 续期 → 401」的死循环。
   */
  function commandsFor(device, deviceState) {
    const base = `${device.deviceId}:${device.configVersion ?? 1}`;
    if (deviceState === DEVICE_STATE.suspended) {
      return [{ commandId: `${base}:1`, type: 'stop-upload', reason: device.statusReason || 'suspended', issuedAtUtc: device.changedAtUtc ?? null }];
    }
    if (deviceState === DEVICE_STATE.revoked) {
      return [
        { commandId: `${base}:1`, type: 'stop-upload', reason: device.statusReason || 'revoked', issuedAtUtc: device.changedAtUtc ?? null },
        { commandId: `${base}:2`, type: 'wipe-credentials', reason: 'revoked', issuedAtUtc: device.changedAtUtc ?? null },
        { commandId: `${base}:3`, type: 'reclaim', reason: 'revoked', issuedAtUtc: device.changedAtUtc ?? null },
      ];
    }
    return [];
  }

  /** 下发给设备的配置。白名单：绝不含采集参数。 */
  function configOf(device) {
    return {
      deviceId: device.deviceId, alias: device.alias, module: moduleOf(device),
      allowedPacks: device.allowedPacks ?? [], allowedAddresses: device.allowedAddresses ?? [],
      allowedEquipment: device.allowedEquipment ?? null,
      allowSimulation: device.allowSimulation === true,
      displayTimeZone: device.displayTimeZone ?? 'Asia/Shanghai',
      uploadEnabled: (device.state ?? 'active') === DEVICE_STATE.active,
      heartbeatIntervalSec: HEARTBEAT.intervalSeconds,
      statusReason: device.statusReason ?? '', changedBy: device.changedBy ?? null,
      changedAtUtc: device.changedAtUtc ?? null, note: device.statusReason ?? '',
    };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://internal'); const prefix=apiPrefix(req.url), isMonitoring=prefix==='/api/monitoring', isExperiment=prefix==='/api/experiment', module=isExperiment?'experiment':'bms'; const state=isExperiment?experiment:states[0]; const pathname = url.pathname.slice(prefix.length);
    // 接入前缀单独分流：必须早于 /admin 与 /heartbeat 判断，否则 module 会被算成 bms。
    if (prefix === DEVICE_PREFIX) return routeDevice(req, res, pathname, url);
    if(isExperiment && pathname.startsWith('/admin'))throw new ApiError(404,'NOT_FOUND','管理接口位于统一设备管理入口');
    if (pathname === '/setup/status' && req.method === 'GET') { rate(`setup-status:${req.socket.remoteAddress}`, 120); return json(res, 200, setupStatus(config)); }
    if (pathname === '/setup/bootstrap' && req.method === 'POST') {
      const s = session(req, false); mutation(req, s); rate(`bootstrap:${req.socket.remoteAddress}`, 5);
      assert(!config.users.length, 409, 'ALREADY_INITIALIZED', '管理员已初始化，请使用账户登录');
      assert(registry.writable && config.bootstrapHash, 503, 'BOOTSTRAP_UNAVAILABLE', '请站点管理员配置持久化存储和初始化密钥');
      const b = await readJson(req); accountInput(b);
      assert(typeof b.bootstrapToken === 'string' && b.bootstrapToken.length <= 256 && equal(tokenHash(b.bootstrapToken), config.bootstrapHash), 403, 'BOOTSTRAP_INVALID', '初始化密钥不正确');
      assert(loginBusy < 4, 429, 'LOGIN_BUSY', '请稍后再试');
      let user; loginBusy++;
      try { const hash = await passwordHash(b.password); user = await registry.mutate((next) => { assert(!next.users.length, 409, 'ALREADY_INITIALIZED', '管理员已初始化'); const u = { username: b.username, passwordHash: hash, role: 'admin', devices: [] }; next.users.push(u); return u; }); }
      finally { loginBusy--; }
      return loggedResponse(res, s, user, 201);
    }
    if (pathname === '/heartbeat' && req.method === 'POST') {
      // 心跳上限取自契约：与客户端下限（HEARTBEAT.minIntervalMs）对齐并留足余量，
      // 不再卡着客户端极限打满——原先 30/分钟对 2 秒下限正好是边界，一次重试就 429。
      const d = deviceAuth(req, module); rate(`heartbeat:${d.deviceId}`, HEARTBEAT.ratePerMinute); const b = await readJson(req);
      deviceAuth(req, module); // 等待正文期间若令牌轮换，不接受旧身份。
      assert(b.deviceId === d.deviceId, 403, 'DEVICE_MISMATCH', '设备身份不匹配');
      assert(typeof b.alias === 'string' && b.alias.length <= 128);
      if(isExperiment){assert(b.module==='experiment',400,'MODULE_INVALID');assert(b.schemaVersion===1,422,'SCHEMA_UNSUPPORTED');}
      // 自述块永不参与鉴权与心跳成败判定：坏数据降级为 null，心跳照常成功。
      const lease = state.heartbeat(d.deviceId, sanitizeClientReport(b.client));
      // 回包带上服务端时间与协商的心跳周期：设备据此算时钟偏移，两端对「多久来一次」有同一份事实。
      const payload = { ...lease, serverTimeUtc: state.iso(), heartbeatIntervalSec: HEARTBEAT.intervalSeconds };
      // 只有声明 protocolVersion>=2 的客户端才追加新字段。
      // 老客户端（含灰度期的旧版本）回包必须逐字节保持旧形状，否则它自己的解析器会以为协议变了。
      const protocol = Number.isInteger(b.protocolVersion) ? b.protocolVersion : 1;
      if (protocol >= 2) {
        const deviceState = d.state ?? DEVICE_STATE.active;
        const uploadAllowed = deviceState === DEVICE_STATE.active;
        if (!uploadAllowed) {
          // 停用/删除：连租约一起收回，避免客户端拿着旧租约继续传。
          payload.subscriptionId = ''; payload.leaseSeconds = 0; payload.backfillSeconds = 0;
          payload[isExperiment ? 'requestedDevices' : 'requestedPacks'] = [];
        }
        payload.protocolVersion = ENROLLMENT.protocolVersion;
        payload.state = deviceState;
        payload.uploadAllowed = uploadAllowed;
        payload.configVersion = d.configVersion ?? 1;
        const reported = Number.isInteger(b.reportedConfigVersion) ? b.reportedConfigVersion : 0;
        if (reported !== payload.configVersion) payload.config = configOf(d);
        const commands = commandsFor(d, deviceState);
        if (commands.length) payload.commands = commands;
      }
      return json(res, 200, payload);
    }
    // 设备自助续期：旧令牌换新令牌，管理员不参与。身份不变，只换凭据。
    if (pathname === '/device/refresh' && req.method === 'POST') {
      const d = deviceAuth(req, module); rate(`refresh:${d.deviceId}`, 5);
      return json(res, 200, await refreshDevice(registry, d.deviceId));
    }
    if (pathname === '/snapshots' && req.method === 'POST') {
      const d = deviceAuth(req, module);
      // 停用/删除只切断上传，不影响本地采集。注意用 403 而不是 401：
      // 401 会触发客户端的自动续期逻辑，进而变成无限重试。
      const deviceState = d.state ?? DEVICE_STATE.active;
      assert(deviceState === DEVICE_STATE.active, deviceState === DEVICE_STATE.revoked ? 410 : 403,
        deviceState === DEVICE_STATE.revoked ? 'DEVICE_REVOKED' : 'DEVICE_SUSPENDED',
        deviceState === DEVICE_STATE.revoked ? '设备已删除，请重新认领' : '设备已停用，云端不接受上传');
      if (isExperiment) experiment.recordSnapshotAttempt(d.deviceId);
      try {
        rate(`snapshots:${d.deviceId}`, 1800); const b = await readJson(req);
        const snapshot = isExperiment?validateExperimentSnapshot(b,deviceAuth(req,module)):validateSnapshot(b, deviceAuth(req, module));
        const result = state.accept(d.deviceId, b.subscriptionId, snapshot);
        if (isExperiment) experiment.recordSnapshotAccepted(d.deviceId);
        return json(res, 200, result);
      } catch (error) {
        if (isExperiment) experiment.recordSnapshotRejected(d.deviceId, error);
        throw error;
      }
    }
    if (pathname === '/backfill' && req.method === 'POST') {
      const d = deviceAuth(req, module);
      const deviceState = d.state ?? DEVICE_STATE.active;
      assert(deviceState === DEVICE_STATE.active, deviceState === DEVICE_STATE.revoked ? 410 : 403,
        deviceState === DEVICE_STATE.revoked ? 'DEVICE_REVOKED' : 'DEVICE_SUSPENDED', '设备未处于可上传状态');
      rate(`backfill:${d.deviceId}`, 300); const b = await readJson(req, TRANSPORT.backfillBodyMaxBytes);
      const payload = isExperiment ? validateExperimentBackfill(b, deviceAuth(req,module)) : validateBmsBackfill(b, deviceAuth(req,module));
      return json(res, 200, state.backfill(d.deviceId, payload.subscriptionId, payload.points));
    }
    if (pathname === '/auth/session' && req.method === 'GET') {
      rate(`session:${req.socket.remoteAddress}`, 120);
      let s;
      try { s = session(req, false); } catch {
        assert(sessions.size < 512, 429, 'SESSION_LIMIT', '观看会话数已达上限');
        const id = opaque(); s = { id, user: null, csrf: opaque(), until: state.now() + 300000 }; sessions.set(id, s); cookie(res, id, 300);
      }
      return json(res, 200, { user: s.user ? { username: s.user.username, role: s.user.role ?? 'viewer', monitoringAccess: s.user.role === 'admin' || !!s.user.monitoringAccess, effectiveDeviceIds: effectiveDeviceIds(s.user) } : null, csrfToken: s.csrf });
    }
    if (pathname === '/auth/login' && req.method === 'POST') {
      const s = session(req, false); mutation(req, s); rate(`login:${req.socket.remoteAddress}`, 10);
      const b = await readJson(req); assert(typeof b.username === 'string' && b.username.length <= 80 && typeof b.password === 'string' && b.password.length <= 256);
      assert(loginBusy < 4, 429, 'LOGIN_BUSY', '请稍后再登录');
      let user = config.users.find((u) => u.username === b.username); let ok;
      loginBusy++; try { ok = await verifyPassword(b.password, (user ?? config.users[0])?.passwordHash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`); } finally { loginBusy--; }
      assert(user && ok, 401, 'LOGIN_FAILED', '用户名或密码不正确');
      const current = config.users.find((u) => u.username === b.username);
      assert(current && !current.disabled && current.passwordHash === user.passwordHash, 401, 'LOGIN_FAILED', '账户状态已变化，请重新登录'); user = current;
      return loggedResponse(res, s, user);
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      const s = session(req); mutation(req, s); sessions.delete(s.id);
      for (const target of states) for (const v of [...target.viewers.values()]) if (v.owner === s.id) target.release(v.viewerId, s.id);
      for (const stream of streams) if (stream.owner === s.id) endStream(stream);
      cookie(res, '', 0); return json(res, 204);
    }
    if (isMonitoring && pathname === '/admin/system') {
      const s = session(req); assert(s.user.role === 'admin', 403, 'ADMIN_REQUIRED', '整体系统配置需要管理员权限');
      if (req.method === 'GET') return json(res, 200, { writable: registry.writable, system: config.system });
      assert(req.method === 'PUT', 405, 'METHOD_NOT_ALLOWED'); mutation(req, s);
      throw new ApiError(410, 'LEGACY_SYSTEM_READ_ONLY', '旧整体系统绑定仅保留只读兼容，请为观察者配置独立设备权限');
    }
    if (isMonitoring && pathname === '/devices' && req.method === 'GET') {
      const s = session(req);
      const ids = effectiveDeviceIds(s.user);
      return json(res, 200, { devices: ids.map(id => config.devices.find(d => d.deviceId === id)).filter(Boolean).map(registeredInfo) });
    }
    if (isMonitoring && pathname === '/admin/cache' && req.method === 'GET') {
      const s = session(req); assert(s.user.role === 'admin', 403, 'ADMIN_REQUIRED', '缓存诊断需要管理员权限');
      return json(res, 200, coordinator.status());
    }
    if (isMonitoring && pathname === '/system' && req.method === 'GET') {
      const s = session(req); assert((s.user.role === 'admin' || s.user.monitoringAccess) && !s.user.disabled, 403, 'MONITORING_FORBIDDEN', '没有整体系统监控权限');
      const { name, allowSimulation } = config.system;
      const bound = (id, target) => {
        if (!id || !target.devices.has(id)) return null;
        const info = target.info(target.device(id));
        return { ...info, allowSimulation: !!(allowSimulation && info.allowSimulation) };
      };
      return json(res, 200, { name, allowSimulation, experimentDevice: bound(config.system.experimentDeviceId, experiment), bmsDevice: bound(config.system.bmsDeviceId, state) });
    }
    if (['/admin/registry', '/admin/devices', '/admin/users'].includes(pathname) || /^\/admin\/devices\/[^/]+(?:\/token)?$/.test(pathname) || /^\/admin\/users\/[^/]+(?:\/devices|\/password)?$/.test(pathname)) {
      const s = session(req); assert(s.user.role === 'admin', 403, 'ADMIN_REQUIRED', '设备和账户注册需要管理员权限'); rate(`admin:${s.user.username}`, 20);
      if (pathname === '/admin/registry' && req.method === 'GET') return json(res, 200, { writable: registry.writable, devices: config.devices.map(registeredInfo), users: config.users.map((u) => ({ username: u.username, role: u.role ?? 'viewer', devices: u.devices, effectiveDeviceIds: effectiveDeviceIds(u), monitoringAccess: u.monitoringAccess ?? false, disabled: u.disabled ?? false })) });
      const userMatch=pathname.match(/^\/admin\/users\/([^/]+)\/devices$/);
      if(userMatch && req.method==='PUT'){mutation(req,s);await updateUserDevices(registry,decodeURIComponent(userMatch[1]),await readJson(req));return json(res,204);}
      const accessMatch=pathname.match(/^\/admin\/users\/([^/]+)$/);
      if(accessMatch && req.method==='PUT'){mutation(req,s);await updateUserMonitoring(registry,decodeURIComponent(accessMatch[1]),await readJson(req));return json(res,204);}
      const passwordMatch=pathname.match(/^\/admin\/users\/([^/]+)\/password$/);
      if(passwordMatch && req.method==='POST'){
        mutation(req,s);const username=decodeURIComponent(passwordMatch[1]);assert(username!==s.user.username,403,'SELF_RESET_FORBIDDEN','管理员不能重置自己的密码');
        assert(loginBusy < 4, 429, 'LOGIN_BUSY', '请稍后再试'); loginBusy++;
        try { await resetUserPassword(registry,username,await readJson(req)); return json(res,204); } finally { loginBusy--; }
      }
      const deleteMatch = pathname.match(/^\/admin\/devices\/([^/]+)$/);
      if (deleteMatch && req.method === 'DELETE') {
        mutation(req, s); const b = await readJson(req);
        await deleteDevice(registry, deleteMatch[1], b); return json(res, 204);
      }
      assert(req.method === 'POST', 405, 'METHOD_NOT_ALLOWED'); mutation(req, s); const b = await readJson(req);
      if (pathname === '/admin/devices') { const result = await registerDevice(registry, b); return json(res, 201, { device: registeredInfo(config.devices.find(d=>d.deviceId===result.deviceId)), deviceToken: result.deviceToken }); }
      if (pathname === '/admin/users') {
        assert(loginBusy < 4, 429, 'LOGIN_BUSY', '请稍后再试'); loginBusy++;
        try { return json(res, 201, { user: await registerUser(registry, b) }); } finally { loginBusy--; }
      }
      const m = pathname.match(/^\/admin\/devices\/([^/]+)\/token$/);
      if (m) { const result = await rotateDevice(registry, m[1], b); return json(res, 200, { device: registeredInfo(config.devices.find(d=>d.deviceId===result.deviceId)), deviceToken: result.deviceToken }); }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    // 未知API永远返回JSON，不交给SPA fallback（也不重定向到登录页）。
    if(isExperiment && pathname==='/catalog' && req.method==='GET'){session(req);return json(res,200,catalog);}
    if (!['/devices', '/viewers', '/events'].includes(pathname) && !/^\/(?:viewers\/[^/]+|devices\/[^/]+\/(?:latest|trend|cache|timeline))$/.test(pathname)) throw new ApiError(404, 'NOT_FOUND', '实时接口不存在');
    const s = session(req);
    rate(`browser:${s.user.username}`, config.browserRequestsPerMinute ?? 5000);
    if (pathname === '/devices' && req.method === 'GET') {
      state.sweep(); const ids = effectiveDeviceIds(s.user);
      return json(res, 200, { devices: ids.filter(id=>state.devices.has(id)).map((id) => state.info(state.device(id))) });
    }
    if (pathname === '/viewers' && req.method === 'POST') {
      mutation(req, s); const b = await readJson(req); const d = authorized(s, b.deviceId, state); const pageId = pageIdInput(b);
      const allActive = activeViewers();
      const active = allActive.filter(({ viewer }) => viewer.principal === s.user.username);
      const pageLeases = active.filter(({ viewer }) => viewer.pageId === pageId);
      assert(pageLeases.every(({ viewer }) => viewer.owner === s.id), 409, 'PAGE_SESSION_CONFLICT', '此页面已由另一登录会话占用');
      assert(!pageLeases.some(({ target }) => target === state), 409, 'PAGE_MODULE_EXISTS', '此页面已创建该模块的观看租约');
      const pageIds = new Set(active.map(({ viewer }) => viewer.pageId));
      assert(pageIds.has(pageId) || pageIds.size < (config.maxViewers ?? 4), 429, 'VIEWER_LIMIT', '观看页面数已达上限');
      const principals = new Set(allActive.map(({ viewer }) => viewer.principal));
      assert(principals.has(s.user.username) || principals.size < (config.maxActiveUsers ?? 10), 429, 'ACTIVE_USER_LIMIT', '同时观看账户数已达上限');
      const source = Object.hasOwn(b, 'source') ? sourceFilter(b.source) : null;
      const requestedHistory = isExperiment ? (Object.hasOwn(b, 'historySelections') ? historyPoints(b.historySelections, d.allowedEquipment) : null) : null;
      return json(res, 201, state.createViewer(s.id, d.deviceId, isExperiment?equipment(b.equipmentIds,d.allowedEquipment):packs(b.packs, d.allowedPacks), s.user.username, source, pageId, requestedHistory));
    }
    const viewerMatch = pathname.match(/^\/viewers\/([^/]+)$/);
    if (viewerMatch && ['PUT', 'DELETE'].includes(req.method)) {
      mutation(req, s); const id = viewerMatch[1];
      if (req.method === 'DELETE') { state.release(id, s.id); return json(res, 204); }
      const v = state.viewer(id, s.id); const d = authorized(s, v.deviceId, state); const b = await readJson(req);
      const source = Object.hasOwn(b, 'source') ? sourceFilter(b.source) : undefined;
      const requestedHistory = isExperiment && Object.hasOwn(b, 'historySelections') ? historyPoints(b.historySelections, d.allowedEquipment) : undefined;
      return json(res, 200, state.renew(id, s.id, isExperiment?equipment(b.equipmentIds,d.allowedEquipment):packs(b.packs, d.allowedPacks), source, requestedHistory));
    }
    const deviceMatch = pathname.match(/^\/devices\/([^/]+)\/(latest|trend|cache|timeline)$/);
    if (deviceMatch) {
      const [, id, resource] = deviceMatch; const d = authorized(s, id, state);
      if (resource === 'timeline' && req.method === 'GET') {
        // 设备事件时间线：回答「什么时候开始坏的、坏之前最后一件好事是什么」。
        return json(res, 200, state.timelineOf(id, url.searchParams.get('limit')));
      }
      if (resource === 'latest' && req.method === 'GET') {
        const selected = isExperiment ? (url.searchParams.has('equipmentIds')?equipment(url.searchParams.get('equipmentIds').split(','),d.allowedEquipment):d.allowedEquipment) : url.searchParams.has('packs') ? packs(url.searchParams.get('packs').split(',').map(Number), d.allowedPacks) : d.allowedPacks;
        return json(res, 200, state.latest(id, selected, sourceFilter(url.searchParams.get('source'))));
      }
      if (resource === 'trend' && req.method === 'GET') {
        const cursor = url.searchParams.get('cursor'), limit = trendLimit(url), source = sourceFilter(url.searchParams.get('source'));
        if(isExperiment){const e=equipment([url.searchParams.get('equipmentId')],d.allowedEquipment)[0], pointId=url.searchParams.get('pointId');
          assert(catalog.points.some(p=>p.equipmentId===e&&p.id===pointId));
          return json(res,200,state.trend(id,e,pointId,source,limit,cursor));
        }
        const pack = packs([Number(url.searchParams.get('pack'))], d.allowedPacks)[0];
        return json(res, 200, state.trend(id, pack, url.searchParams.get('metric'), limit, source, cursor));
      }
      if (resource === 'cache' && req.method === 'DELETE') {
        mutation(req, s); assert(s.user.role === 'admin', 403, 'ADMIN_REQUIRED', '只有管理员可以清理缓存'); state.clear(id); return json(res, 204);
      }
    }
    if (pathname === '/events' && req.method === 'GET') {
      const id = url.searchParams.get('viewerId'); assert(identifier(id));
      const v = state.viewer(id, s.id); authorized(s, v.deviceId, state);
      const source = sourceFilter(url.searchParams.get('source')) ?? v.sources?.[0] ?? null;
      for (const existing of [...streams]) if (existing.viewerId === id) endStream(existing); // EventSource重连替换旧流。
      assert([...streams].filter((e) => e.username === s.user.username).length < (config.maxSsePerUser ?? 8), 429, 'SSE_LIMIT', '实时订阅连接数已达上限');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' }); res.flushHeaders();
      const stream = { target:state, res, viewerId: id, deviceId: v.deviceId, owner: s.id, username: s.user.username, source }; streams.add(stream);
      res.on('close', () => streams.delete(stream));
      const initialStatus = state.info(state.device(v.deviceId));
      if (isExperiment) initialStatus.uploadStatus = state.getUploadStatus(v.deviceId);
      write(stream, 'device-status', initialStatus); write(stream, 'cache-status', coordinator.status());
      for (const item of (isExperiment?state.latest(v.deviceId,v.packs,source).snapshots:state.latest(v.deviceId, v.packs,source).packs)) write(stream, 'snapshot', item);
      return;
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该接口不支持此请求方法');
  }
  return {
    state, experiment,
    async handle(req, res) {
      if (!apiPrefix(req.url)) return false;
      try { await route(req, res); } catch (error) {
        if (res.headersSent) { res.destroy(); return true; }
        const safe = error instanceof ApiError ? error : new ApiError(503, 'SERVICE_UNAVAILABLE', '实时服务暂不可用');
        if (safe.code === 'CACHE_CAPACITY_EXCEEDED') for (const stream of streams) write(stream, 'cache-capacity', coordinator.status());
        if (safe.status === 413 || safe.code === 'BODY_TIMEOUT') res.setHeader('Connection', 'close');
        json(res, safe.status, { error: { code: safe.code, message: safe.message } });
      }
      return true;
    },
    close() { clearInterval(maintenance); for (const stream of streams) endStream(stream); for(const target of states)target.listeners.clear(); },
  };
}
