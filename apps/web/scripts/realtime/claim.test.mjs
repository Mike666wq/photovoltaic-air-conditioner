import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealtimeApi } from './routes.mjs';
import { loadConfig } from './auth.mjs';

const origin = 'https://example.test';
const bootstrapToken = 'device-claim-bootstrap-token-0123456789';
const password = 'fixture-viewer-password';
const machineKey = 'mk_0123456789abcdef0123456789abcdef';
const machineKey2 = 'mk_fedcba9876543210fedcba9876543210';
const claimSecret = 'claim-secret-abcdefghijklmnopqrstuvwxyz012345';
const claimSecret2 = 'claim-secret-zyxwvutsrqponmlkjihgfedcba543210';

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pv-claim-'));
  const key = join(dir, 'bootstrap.key');
  writeFileSync(key, bootstrapToken, { mode: 0o600 });
  const env = {
    BMS_REALTIME_ENABLED: '1',
    BMS_REALTIME_REGISTRY_DIR: join(dir, 'storage'),
    BMS_REALTIME_PUBLIC_ORIGIN: origin,
    BMS_REALTIME_BOOTSTRAP_TOKEN_FILE: key,
  };
  const api = createRealtimeApi({ config: loadConfig(env) });
  const server = createServer(async (req, res) => { if (!(await api.handle(req, res))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { api.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(root + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
  };
  const guest = async () => {
    const g = await call('/api/realtime/auth/session');
    return { Cookie: g.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': g.body.csrfToken };
  };
  const setup = async () => {
    const res = await call('/api/realtime/setup/bootstrap', 'POST', { username: 'fixture-admin', password, bootstrapToken }, await guest());
    assert.equal(res.status, 201);
    const headers = { Cookie: res.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': res.body.csrfToken };
    return { headers, call: (p, m, b) => call(p, m, b, headers) };
  };
  const claim = (secret, body) => call('/api/device/claim', 'POST', body, { Authorization: `Bearer ${secret}` });
  return { api, dir, call, setup, claim };
}

test('认领：创建 pending、幂等、批准后一次性交付令牌、ack 后转 active', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();

  const first = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2, desiredAlias: '3号柜 BMS' });
  assert.equal(first.status, 201);
  assert.equal(first.body.state, 'pending');
  assert.equal(typeof first.body.claimId, 'string');

  // 幂等：同 key + 同 secret 再来一次，必须返回同一个 claimId，不能新建。
  const again = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  assert.equal(again.status, 201);
  assert.equal(again.body.claimId, first.body.claimId);

  // 同 key 换 secret = 抢占，必须拒绝。
  assert.equal((await h.claim(claimSecret2, { machineKey, module: 'bms' })).status, 401);

  // 设备在 pending 期拿不到任何业务能力：没有令牌就无法通过 deviceAuth。
  assert.equal((await h.call('/api/realtime/heartbeat', 'POST', { deviceId: machineKey, alias: 'x' })).status, 401);

  const pending = await admin.call('/api/device/admin/claims');
  assert.equal(pending.body.claims.length, 1);
  assert.equal(pending.body.claims[0].machineKey, machineKey);

  const approved = await admin.call(`/api/device/admin/claims/${first.body.claimId}/approve`, 'POST', {
    deviceId: 'BMS-LAB-03-2026-11', alias: '3号柜 BMS', allowedPacks: [1, 2], allowedAddresses: [1], allowSimulation: false,
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.state, 'approved');

  // 取令牌：明文只给一次。
  const poll = await h.call(`/api/device/claim/${first.body.claimId}`, 'POST', {}, { Authorization: `Bearer ${claimSecret}` });
  assert.equal(poll.status, 200);
  assert.equal(typeof poll.body.deviceToken, 'string');
  assert.equal(poll.body.config.allowedPacks.join(','), '1,2');
  const token = poll.body.deviceToken;

  // 再取一次：不再有明文，只能看到「已交付」。
  const second = await h.call(`/api/device/claim/${first.body.claimId}`, 'POST', {}, { Authorization: `Bearer ${claimSecret}` });
  assert.equal(second.body.deviceToken, undefined);
  assert.equal(second.body.tokenDelivered, true);

  // ack 之后转 active，并且令牌真的能用。
  const acked = await h.call('/api/device/ack', 'POST', { claimId: first.body.claimId, ackType: 'activation', persisted: true }, { Authorization: `Bearer ${claimSecret}` });
  assert.equal(acked.status, 200);
  assert.equal(acked.body.state, 'active');

  const beat = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'BMS-LAB-03-2026-11', alias: '3号柜 BMS', protocolVersion: 2, reportedConfigVersion: 0 }, { Authorization: `Bearer ${token}` });
  assert.equal(beat.status, 200);
  assert.equal(beat.body.state, 'active');
  assert.equal(beat.body.uploadAllowed, true);
  assert.equal(beat.body.configVersion, 1);
  assert.equal(beat.body.config.allowedPacks.join(','), '1,2');
  // 最后一拍配置已下发，再发同样版本就不该重复下发。
  const quiet = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'BMS-LAB-03-2026-11', alias: '3号柜 BMS', protocolVersion: 2, reportedConfigVersion: 1 }, { Authorization: `Bearer ${token}` });
  assert.equal(quiet.body.config, undefined);
});

test('灰度兼容：不声明 protocolVersion 的客户端，回包形状与旧版完全一致', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const created = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${created.body.claimId}/approve`, 'POST', { deviceId: 'bms-legacy-shape', alias: '旧客户端', allowedPacks: [1], allowedAddresses: [1] });
  const poll = await h.call(`/api/device/claim/${created.body.claimId}`, 'POST', {}, { Authorization: `Bearer ${claimSecret}` });
  await h.call('/api/device/ack', 'POST', { claimId: created.body.claimId, ackType: 'activation', persisted: true }, { Authorization: `Bearer ${claimSecret}` });

  const beat = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'bms-legacy-shape', alias: '旧客户端' }, { Authorization: `Bearer ${poll.body.deviceToken}` });
  assert.equal(beat.status, 200);
  // 老协议必须看不到任何新字段，否则它自己的解析器会以为协议变了。
  for (const field of ['protocolVersion', 'state', 'uploadAllowed', 'configVersion', 'config', 'commands']) {
    assert.equal(beat.body[field], undefined, `老协议回包不得出现 ${field}`);
  }
  assert.equal(typeof beat.body.subscriptionId, 'string');
  assert.equal(typeof beat.body.leaseSeconds, 'number');
  assert.ok(Array.isArray(beat.body.requestedPacks));
});

test('停用只切断上传：心跳照常、租约收回、快照 403；恢复后重新可用', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const created = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${created.body.claimId}/approve`, 'POST', { deviceId: 'bms-suspend-01', alias: '可停用', allowedPacks: [1], allowedAddresses: [1] });
  const poll = await h.call(`/api/device/claim/${created.body.claimId}`, 'POST', {}, { Authorization: `Bearer ${claimSecret}` });
  const token = poll.body.deviceToken;
  await h.call('/api/device/ack', 'POST', { claimId: created.body.claimId, ackType: 'activation', persisted: true }, { Authorization: `Bearer ${claimSecret}` });

  const suspended = await admin.call('/api/device/admin/devices/bms-suspend-01/suspend', 'POST', { reason: '维护中' });
  assert.equal(suspended.status, 200);

  const beat = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'bms-suspend-01', alias: '可停用', protocolVersion: 2 }, { Authorization: `Bearer ${token}` });
  assert.equal(beat.status, 200, '停用不得让心跳失败，否则客户端会以为网络坏了');
  assert.equal(beat.body.state, 'suspended');
  assert.equal(beat.body.uploadAllowed, false);
  assert.equal(beat.body.leaseSeconds, 0);
  assert.equal(beat.body.commands[0].type, 'stop-upload');

  const rejected = await h.call('/api/realtime/snapshots', 'POST', { subscriptionId: '', snapshot: {} }, { Authorization: `Bearer ${token}` });
  assert.equal(rejected.status, 403);

  await admin.call('/api/device/admin/devices/bms-suspend-01/resume', 'POST', {});
  const resumed = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'bms-suspend-01', alias: '可停用', protocolVersion: 2 }, { Authorization: `Bearer ${token}` });
  assert.equal(resumed.body.state, 'active');
  assert.equal(resumed.body.uploadAllowed, true);
});

test('删除走墓碑：心跳回 revoked 指令而不是 401，避免客户端续期死循环', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const created = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${created.body.claimId}/approve`, 'POST', { deviceId: 'bms-revoke-01', alias: '将删除', allowedPacks: [1], allowedAddresses: [1] });
  const poll = await h.call(`/api/device/claim/${created.body.claimId}`, 'POST', {}, { Authorization: `Bearer ${claimSecret}` });
  const token = poll.body.deviceToken;
  await h.call('/api/device/ack', 'POST', { claimId: created.body.claimId, ackType: 'activation', persisted: true }, { Authorization: `Bearer ${claimSecret}` });

  assert.equal((await admin.call('/api/device/admin/devices/bms-revoke-01', 'DELETE', { reason: '退役' })).status, 200);

  const beat = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'bms-revoke-01', alias: '将删除', protocolVersion: 2 }, { Authorization: `Bearer ${token}` });
  assert.equal(beat.status, 200, '删除后心跳必须仍可达，否则指令送不到、客户端会无限重试');
  assert.equal(beat.body.state, 'revoked');
  assert.equal(beat.body.uploadAllowed, false);
  assert.deepEqual(beat.body.commands.map((c) => c.type), ['stop-upload', 'wipe-credentials', 'reclaim']);

  assert.equal((await h.call('/api/realtime/snapshots', 'POST', { subscriptionId: '', snapshot: {} }, { Authorization: `Bearer ${token}` })).status, 410);

  // 墓碑对「实时观测」不可见。
  assert.equal((await admin.call('/api/realtime/devices')).body.devices.length, 0);
});

test('安全边界：待批准列表要管理员，认领端点限流且不接受非法机器钥匙', async (t) => {
  const h = await harness(t);
  await h.setup();
  assert.equal((await h.call('/api/device/admin/claims')).status, 401);
  assert.equal((await h.claim(claimSecret, { machineKey: 'not-a-key', module: 'bms' })).status, 400);
  assert.equal((await h.claim('short', { machineKey, module: 'bms' })).status, 401);
  assert.equal((await h.claim(claimSecret, { machineKey, module: 'nope' })).status, 400);
  assert.equal((await h.call('/api/device/claim/deadbeef', 'POST', {}, { Authorization: `Bearer ${claimSecret}` })).status, 404);
});

test('同一台机器可登记两个模块，互不干扰', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const bms = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${bms.body.claimId}/approve`, 'POST', { deviceId: 'host01-bms', alias: 'BMS 侧', allowedPacks: [1], allowedAddresses: [1] });
  const exp = await h.claim(claimSecret2, { machineKey: machineKey2, module: 'experiment', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${exp.body.claimId}/approve`, 'POST', { deviceId: 'host01-exp', alias: '实验侧', allowedEquipment: ['PLC'] });

  const devices = (await admin.call('/api/device/admin/devices')).body.devices;
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((d) => d.module).sort(), ['bms', 'experiment']);
});
