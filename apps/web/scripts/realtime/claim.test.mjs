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

test('重新认领：上一轮已批准的记录不该挡住新申请', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const first = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${first.body.claimId}/approve`, 'POST', {
    deviceId: 'bms-reclaim-01', alias: '重连测试', allowedPacks: [1], allowedAddresses: [1],
  });
  // 设备侧丢掉了 claimSecret（重装/清目录）：换一把新 secret 重新认领。
  // 上一轮那条记录已经是 approved，secret 哈希永远不会再匹配 —— 如果这里要求匹配，
  // 设备就永远卡在 401，表现为「点了重新申请，云端什么都没有」。
  const again = await h.claim(claimSecret2, { machineKey, module: 'bms', protocolVersion: 2 });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.claimId, first.body.claimId);
  // 这台机器已经登记过：重连不再等人工批准，直接发一枚新令牌并把旧令牌作废。
  assert.equal(again.body.state, 'approved');
  assert.ok(again.body.deviceToken, '重连应该直接拿到令牌');
});

test('同一台机器重新批准时复活原设备，编号不变', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const original = 'bms-keep-id-01';
  const first = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${first.body.claimId}/approve`, 'POST', {
    deviceId: original, alias: '原设备', allowedPacks: [1], allowedAddresses: [1],
  });

  // 设备被删除（墓碑）后重新接入：应当复活同一台设备，而不是再建一台新编号的。
  await admin.call(`/api/device/admin/devices/${original}`, 'DELETE', { reason: '重装' });
  const again = await h.claim(claimSecret2, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${again.body.claimId}/approve`, 'POST', {
    alias: '重装后', allowedPacks: [2], allowedAddresses: [1],
  });

  const devices = (await admin.call('/api/device/admin/devices')).body.devices;
  assert.equal(devices.length, 1, '不该多出一台设备');
  assert.equal(devices[0].deviceId, original, '编号必须保持不变');
  assert.equal(devices[0].alias, '重装后');
  assert.ok(devices[0].configVersion >= 3, '配置版本应继续递增');
});

test('确认可以用设备令牌（客户端落盘后 claimSecret 已清空）', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const created = await h.claim(claimSecret, { machineKey, module: 'bms', protocolVersion: 2 });
  await admin.call(`/api/device/admin/claims/${created.body.claimId}/approve`, 'POST', {
    deviceId: 'bms-ack-token', alias: '确认测试', allowedPacks: [1], allowedAddresses: [1],
  });
  const poll = await h.call(`/api/device/claim/${created.body.claimId}`, 'POST', {}, { Authorization: `Bearer ${claimSecret}` });
  // 客户端拿到令牌后会立刻清空 claimSecret，确认时手里只有 deviceToken。
  // 只认 claimSecret 的话这里永远 401，设备卡在 approved 再也发不出心跳。
  const acked = await h.call('/api/device/ack', 'POST', { claimId: created.body.claimId, persisted: true }, { Authorization: `Bearer ${poll.body.deviceToken}` });
  assert.equal(acked.status, 200);
  assert.equal(acked.body.state, 'active');
  const beat = await h.call('/api/realtime/heartbeat', 'POST', { deviceId: 'bms-ack-token', alias: '确认测试', protocolVersion: 2 }, { Authorization: `Bearer ${poll.body.deviceToken}` });
  assert.equal(beat.status, 200);
  assert.equal(beat.body.state, 'active');
});

test('重新批准只改传了的字段：已有授权与模拟开关不能被冲回默认值', async (t) => {
  // 现场踩过两次：管理员在网页上点「批准」重新接入，服务端把 allowSimulation
  // 无条件下调成 false、仪器清单也被写成 ['PLC']，表现为「批准成功了反而没数据」。
  const h = await harness(t);
  const admin = await h.setup();
  const first = await h.claim(claimSecret, { machineKey, module: 'experiment', protocolVersion: 2 });
  const approved = await admin.call(`/api/device/admin/claims/${first.body.claimId}/approve`, 'POST', {
    alias: '实验端', allowedEquipment: ['DS666', 'PLC', 'DDSU666', 'DJSF6682'], allowSimulation: true, alwaysUpload: true,
  });
  assert.equal(approved.status, 201);

  // 已知机器重连会自动批准；这里验证「只改名字」时不会顺手把授权冲回默认值。
  const renamed = await admin.call(`/api/device/admin/devices/${approved.body.deviceId}`, 'PUT', { alias: '实验端改名' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.deviceId, approved.body.deviceId);

  const listed = await admin.call('/api/device/admin/devices', 'GET');
  const device = listed.body.devices.find((item) => item.deviceId === approved.body.deviceId);
  assert.deepEqual([...device.allowedEquipment].sort(), ['DS666', 'DDSU666', 'PLC', 'DJSF6682'].sort());
  assert.equal(device.allowSimulation, true);
  assert.equal(device.alwaysUpload, true);
});

test('新设备批准后默认常驻上传，不需要再手动打开', async (t) => {
  // 现场选的是「常驻上传」：没有观看者也要传。如果批准后 alwaysUpload 是 false，
  // 新接的设备又会退回「没人看就不传」，页面上表现为「过一会儿就没数据」。
  const h = await harness(t);
  const admin = await h.setup();
  const claim = await h.claim(claimSecret, { machineKey, module: 'experiment', protocolVersion: 2 });
  const approved = await admin.call(`/api/device/admin/claims/${claim.body.claimId}/approve`, 'POST', { alias: '新设备' });
  assert.equal(approved.status, 201);
  const listed = await admin.call('/api/device/admin/devices', 'GET');
  const device = listed.body.devices.find((item) => item.deviceId === approved.body.deviceId);
  assert.equal(device.alwaysUpload, true);
  assert.equal(device.allowedEquipment.length, 4);
});

test('批准对整台机器生效：换了一张认领单也能取到令牌', async (t) => {
  // 本地被云端限流会重新申请，管理员批的往往是上一张单子；按认领单查就永远查不到结果，
  // 表现为「网页显示已批准，本地一直等待批准」，只能人工再批一次。
  const h = await harness(t);
  const admin = await h.setup();
  const first = await h.claim(claimSecret, { machineKey, module: 'experiment', protocolVersion: 2 });
  const approved = await admin.call(`/api/device/admin/claims/${first.body.claimId}/approve`, 'POST', {
    alias: '实验端', allowedEquipment: ['PLC'], allowSimulation: true,
  });
  assert.equal(approved.status, 201);

  // 设备换了一把 secret 重新认领（新的 claimId），然后按新单子查询状态。
  const second = await h.claim(claimSecret2, { machineKey, module: 'experiment', protocolVersion: 2 });
  assert.equal(second.status, 201);
  // 重新认领仍然会生成一张新单（既有契约），但上一张「已批准、令牌未取走」的单子
  // 不会被删掉 —— 删了就把一次性令牌一起删了，设备永远等不到授权。
  assert.notEqual(second.body.claimId, first.body.claimId);

  // 这台机器已经登记过，重新认领直接批准并发新令牌（旧令牌作废），
  // 不必再等管理员点第二次 —— 否则就是「网页上批了，本地还在等待批准」。
  assert.equal(second.body.state, 'approved');
  assert.equal(second.body.deviceId, approved.body.deviceId);
  assert.ok(second.body.deviceToken, '应该交付令牌');
});
