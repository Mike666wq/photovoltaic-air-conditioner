import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealtimeApi } from './routes.mjs';
import { loadConfig, passwordHash, tokenHash } from './auth.mjs';

const origin = 'https://example.test';
const password = 'fixture-password-12-characters';
const adminPassword = 'fixture-admin-password-12-chars';
const bmsToken = 'fixture-bms-token-for-management-tests';
const experimentToken = 'fixture-experiment-token-management';

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pv-management-'));
  const key = join(dir, 'bootstrap.key'); writeFileSync(key, 'bootstrap-token-for-management-tests', { mode: 0o600 });
  const env = { BMS_REALTIME_ENABLED: '1', BMS_REALTIME_REGISTRY_DIR: join(dir, 'registry'), BMS_REALTIME_PUBLIC_ORIGIN: origin, BMS_REALTIME_BOOTSTRAP_TOKEN_FILE: key };
  const config = loadConfig(env);
  config.devices = [
    { deviceId: 'management-bms', alias: '测试BMS', allowedPacks: [1], allowedAddresses: [1], allowSimulation: true, deviceTokenHash: tokenHash(bmsToken) },
    { deviceId: 'management-experiment', alias: '测试实验设备', module: 'experiment', allowedEquipment: ['DS666'], allowSimulation: true, deviceTokenHash: tokenHash(experimentToken) },
  ];
  config.users = [
    { username: 'management-admin', passwordHash: await passwordHash(adminPassword), role: 'admin', devices: [] },
    { username: 'system-viewer', passwordHash: await passwordHash(password), role: 'viewer', devices: [], monitoringAccess: true },
    { username: 'legacy-viewer', passwordHash: await passwordHash(password), role: 'viewer', devices: ['management-bms'] },
  ];
  config.system = { name: '旧系统绑定', experimentDeviceId: 'management-experiment', bmsDeviceId: 'management-bms', allowSimulation: true };
  const api = createRealtimeApi({ config });
  const server = createServer(async (req, res) => { if (!await api.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { api.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (prefix, path, method = 'GET', body, headers = {}) => {
    const response = await fetch(root + prefix + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  const guest = async () => { const response = await call('/api/realtime', '/auth/session'); return { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': response.body.csrfToken }; };
  const login = async (username, secret = username === 'management-admin' ? adminPassword : password) => {
    const response = await call('/api/realtime', '/auth/login', 'POST', { username, password: secret }, await guest());
    assert.equal(response.status, 200); const headers = { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': response.body.csrfToken };
    return { headers, call: (path, method, body) => call('/api/realtime', path, method, body, headers), callModule: (prefix, path, method, body) => call(prefix, path, method, body, headers) };
  };
  const admin = await login('management-admin');
  return { api, config, dir, env, root, call, login, admin, file: join(env.BMS_REALTIME_REGISTRY_DIR, 'registry.json') };
}

test('旧系统绑定只读兼容，legacy授权可见绑定设备且管理员跨模块查看全部设备', async (t) => {
  const h = await harness(t); const admin = h.admin;
  const read = await admin.callModule('/api/monitoring', '/admin/system'); assert.equal(read.status, 200); assert.equal(read.body.system.bmsDeviceId, 'management-bms');
  const priorSystem = structuredClone(h.config.system);
  const oldFile = JSON.stringify({ version: 1, devices: h.config.devices, users: h.config.users, system: priorSystem });
  mkdirSync(h.env.BMS_REALTIME_REGISTRY_DIR, { recursive: true });
  writeFileSync(h.file, oldFile);
  const update = await admin.callModule('/api/monitoring', '/admin/system', 'PUT', { ...priorSystem, bmsDeviceId: null });
  assert.equal(update.status, 410); assert.deepEqual(h.config.system, priorSystem);
  const system = (await admin.callModule('/api/monitoring', '/system')).body;
  assert.equal(system.name, priorSystem.name); assert.equal(system.bmsDevice.allowSimulation, true); assert.equal(system.experimentDevice.allowSimulation, true);
  assert.deepEqual((await admin.callModule('/api/monitoring', '/devices')).body.devices.map(d => d.module).sort(), ['bms', 'experiment']);
  const viewer = await h.login('system-viewer');
  assert.equal((await viewer.callModule('/api/monitoring', '/system')).status, 200);
  assert.equal((await viewer.callModule('/api/monitoring', '/devices')).body.devices.length, 2);
  assert.equal((await viewer.call('/devices')).body.devices.some(d => d.deviceId === 'management-bms'), true);
  assert.equal((await viewer.callModule('/api/experiment', '/devices')).body.devices.some(d => d.deviceId === 'management-experiment'), true);
  const legacy = await h.login('legacy-viewer');
  assert.equal((await legacy.callModule('/api/monitoring', '/system')).status, 403);
  assert.equal((await legacy.call('/devices')).body.devices.length, 1);
  assert.equal((await legacy.callModule('/api/experiment', '/devices')).body.devices.length, 0);
  const oldBytes = readFileSync(h.file, 'utf8');
  assert.equal(oldBytes, oldFile);
  assert(!oldBytes.includes('effectiveDeviceIds'));
  assert.equal((await admin.call('/admin/registry')).body.users.find(u => u.username === 'system-viewer').effectiveDeviceIds.length, 2);
});

test('新增同类设备不会扩大旧整体授权，管理员列表包含所有独立设备', async (t) => {
  const h = await harness(t); const admin = h.admin; const viewer = await h.login('system-viewer');
  const added = await admin.call('/admin/devices', 'POST', { deviceId: 'management-bms-extra', alias: '额外BMS', allowedPacks: [1], allowedAddresses: [1] });
  assert.equal(added.status, 201);
  const adminDevices = (await admin.callModule('/api/monitoring', '/devices')).body.devices;
  assert.equal(adminDevices.length, 3);
  assert.equal(adminDevices.filter(d => d.module === 'bms').length, 2);
  const viewerDevices = (await viewer.callModule('/api/monitoring', '/devices')).body.devices;
  assert.deepEqual(viewerDevices.map(d => d.deviceId).sort(), ['management-bms', 'management-experiment']);
  const listedUser = (await admin.call('/admin/registry')).body.users.find(u => u.username === 'system-viewer');
  assert(!listedUser.effectiveDeviceIds.includes('management-bms-extra'));
});

test('撤销观察者设备权限即时释放两路租约，删除绑定设备不恢复旧授权', async (t) => {
  const h = await harness(t); const admin = h.admin;
  const viewer = await h.login('system-viewer');
  const bmsViewer = await viewer.call('/viewers', 'POST', { deviceId: 'management-bms', packs: [1] });
  const expViewer = await viewer.callModule('/api/experiment', '/viewers', 'POST', { deviceId: 'management-experiment', equipmentIds: ['DS666'] });
  assert.equal(bmsViewer.status, 201); assert.equal(expViewer.status, 201);
  assert.equal((await viewer.call('/viewers/' + bmsViewer.body.viewerId, 'PUT', { packs: [1] })).status, 200);
  assert.equal((await viewer.callModule('/api/experiment', '/viewers/' + expViewer.body.viewerId, 'PUT', { equipmentIds: ['DS666'] })).status, 200);
  assert.equal((await admin.call('/admin/users/system-viewer', 'PUT', { devices: [], disabled: false, monitoringAccess: false })).status, 204);
  assert.equal((await viewer.call('/viewers/' + bmsViewer.body.viewerId, 'PUT', { packs: [1] })).status, 410);
  assert.equal((await viewer.callModule('/api/experiment', '/viewers/' + expViewer.body.viewerId, 'PUT', { equipmentIds: ['DS666'] })).status, 410);
  assert.equal((await viewer.callModule('/api/monitoring', '/system')).status, 403);
  assert.equal((await admin.call('/admin/users/system-viewer', 'PUT', { monitoringAccess: true, disabled: false })).status, 204);
  assert.equal((await admin.call('/admin/devices/management-experiment', 'DELETE', { confirmDeviceId: 'management-experiment' })).status, 204);
  const configAfterRestart = loadConfig(h.env);
  assert.equal(configAfterRestart.system.experimentDeviceId, null);
  assert.equal(configAfterRestart.users.find(u => u.username === 'system-viewer').monitoringAccess, true);
});

test('停用和重置密码撤销会话，管理员不能停用自己或重置自己的密码', async (t) => {
  const h = await harness(t); const admin = h.admin; const viewer = await h.login('system-viewer');
  assert.equal((await admin.call('/admin/users/management-admin', 'PUT', { monitoringAccess: true, disabled: true })).status, 400);
  assert.equal((await admin.call('/admin/users/management-admin/password', 'POST', { password: 'new-admin-password-12chars' })).status, 403);
  assert.equal((await admin.call('/admin/users/system-viewer/password', 'POST', { password: 'new-viewer-password-12chars' })).status, 204);
  assert.equal((await viewer.call('/devices')).status, 401);
  const nextPassword = await h.login('system-viewer', 'new-viewer-password-12chars');
  assert.equal((await admin.call('/admin/users/system-viewer', 'PUT', { monitoringAccess: true, disabled: true })).status, 204);
  assert.equal((await nextPassword.callModule('/api/monitoring', '/system')).status, 401);
  assert.equal((await h.login('system-viewer', 'new-viewer-password-12chars').catch(() => null)), null);
});

test('撤销一个设备权限发送明确SSE事件并保留同会话的其他设备观看', async (t) => {
  const h = await harness(t); const admin = h.admin; const viewer = await h.login('system-viewer');
  const bms = await viewer.call('/viewers', 'POST', { deviceId: 'management-bms', packs: [1] });
  const exp = await viewer.callModule('/api/experiment', '/viewers', 'POST', { deviceId: 'management-experiment', equipmentIds: ['DS666'] });
  assert.equal(bms.status, 201); assert.equal(exp.status, 201);
  const abortBms = new AbortController(), abortExp = new AbortController();
  const openEvents = (prefix, id, signal) => fetch(h.root + prefix + '/events?viewerId=' + encodeURIComponent(id), { headers: viewer.headers, signal: signal.signal });
  const bmsResponse = await openEvents('/api/realtime', bms.body.viewerId, abortBms);
  const expResponse = await openEvents('/api/experiment', exp.body.viewerId, abortExp);
  const bmsReader = bmsResponse.body.getReader(), expReader = expResponse.body.getReader();
  await bmsReader.read(); await expReader.read();
  assert.equal((await admin.call('/admin/users/system-viewer', 'PUT', { devices: ['management-experiment'], disabled: false, monitoringAccess: false })).status, 204);
  let packets = '';
  const revoked = await Promise.race([(async () => { while (true) { const item = await bmsReader.read(); if (item.done) return packets; packets += new TextDecoder().decode(item.value); if (packets.includes('event: permission-revoked')) return packets; } })(), new Promise(resolve => setTimeout(() => resolve(null), 2000))]);
  assert.notEqual(revoked, null);
  assert.match(revoked, /event: permission-revoked/);
  assert.equal((await viewer.callModule('/api/experiment', '/viewers/' + exp.body.viewerId, 'PUT', { equipmentIds: ['DS666'] })).status, 200);
  assert.equal((await viewer.call('/viewers/' + bms.body.viewerId, 'PUT', { packs: [1] })).status, 410);
  abortBms.abort(); abortExp.abort(); await bmsReader.cancel().catch(() => {}); await expReader.cancel().catch(() => {});
});
