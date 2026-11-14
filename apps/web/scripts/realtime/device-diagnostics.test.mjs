import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealtimeApi } from './routes.mjs';
import { loadConfig } from './auth.mjs';
import { sanitizeClientReport, HEARTBEAT } from './base-contract.mjs';

const origin = 'https://example.test';
const bootstrapToken = 'diagnostics-bootstrap-token-0123456789';
const password = 'fixture-viewer-password';

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pv-diag-'));
  const key = join(dir, 'bootstrap.key');
  writeFileSync(key, bootstrapToken, { mode: 0o600 });
  const env = {
    BMS_REALTIME_ENABLED: '1',
    BMS_REALTIME_REGISTRY_DIR: join(dir, 'storage'),
    BMS_REALTIME_PUBLIC_ORIGIN: origin,
    BMS_REALTIME_BOOTSTRAP_TOKEN_FILE: key,
  };
  // 可控时钟：离线判定与时间线都靠推进 mono 来驱动，不睡真实时间。
  let mono = 0;
  const base = Date.parse('2026-11-14T02:00:00Z');
  const api = createRealtimeApi({ config: loadConfig(env), clocks: { now: () => mono, wall: () => base + mono } });
  const server = createServer(async (req, res) => { if (!(await api.handle(req, res))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { api.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(root + '/api/realtime' + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
  };
  const guest = async () => {
    const g = await call('/auth/session');
    return { Cookie: g.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': g.body.csrfToken };
  };
  const signed = (res) => {
    const headers = { Cookie: res.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': res.body.csrfToken };
    return { headers, call: (p, m, b) => call(p, m, b, headers) };
  };
  const setup = async () => {
    const res = await call('/setup/bootstrap', 'POST', { username: 'fixture-admin', password, bootstrapToken }, await guest());
    assert.equal(res.status, 201);
    return signed(res);
  };
  return { api, call, setup, root, advance: (ms) => { mono += ms; }, now: () => mono };
}

// 注册一台设备并拿回明文令牌（走真实管理接口，不直接改内存）。
async function registerDevice(h, admin, deviceId = 'lab-bms-01') {
  const res = await admin.call('/admin/devices', 'POST', {
    deviceId, alias: '实验室 BMS', module: 'bms', allowedPacks: [1, 2], allowedAddresses: [1],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.deviceToken;
}

const beat = (h, token, body = {}) =>
  h.call('/heartbeat', 'POST', { deviceId: 'lab-bms-01', alias: '实验室 BMS', ...body }, { Authorization: `Bearer ${token}` });

test('自述清洗器：坏数据降级为 null，绝不抛错', () => {
  assert.equal(sanitizeClientReport(undefined), null);
  assert.equal(sanitizeClientReport('not-an-object'), null);
  assert.deepEqual(sanitizeClientReport({ lastError: { stage: 'NOPE' } }), null); // 未知阶段不猜
  assert.equal(sanitizeClientReport({ version: 'x'.repeat(9999) }), null);        // 超限整块丢弃
  const ok = sanitizeClientReport({
    version: '1.2.8', uptimeSec: 10, cloudEnabled: true, bogusField: 'ignored',
    lastError: { stage: 'TLS', httpStatus: 999, count: 3 },
  });
  assert.equal(ok.version, '1.2.8');
  assert.equal(ok.bogusField, undefined, '未知字段必须被丢弃');
  assert.equal(ok.lastError.httpStatus, undefined, '越界 HTTP 状态码必须被丢弃');
  assert.equal(ok.lastError.stage, 'TLS');
});

test('心跳携带自述：进入设备信息，且坏自述不影响心跳成功', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const token = await registerDevice(h, admin);

  // 没有自述时：心跳照常 200，client 为 null（未知 ≠ 正常）
  assert.equal((await beat(h, token)).status, 200);
  let devices = (await admin.call('/devices')).body.devices;
  assert.equal(devices[0].client, null);
  assert.equal(devices[0].firstSeenAt !== null, true, '首次心跳必须落 firstSeenAt');
  assert.equal(devices[0].missedBeats, 0);

  // 坏自述：心跳仍然 200，且不污染已存内容
  const bad = await beat(h, token, { client: { lastError: { stage: 'NOT_A_STAGE' } } });
  assert.equal(bad.status, 200, '坏自述不得让心跳失败');

  // 好自述：结构化字段全部落地
  const good = await beat(h, token, {
    client: {
      version: '1.2.8', uptimeSec: 120, cloudEnabled: true, tokenDecryptable: true,
      consecutiveFailures: 2, nextRetryInSec: 40,
      localTimeUtc: new Date(Date.parse('2026-11-14T02:00:00Z') + h.now()).toISOString(),
      lastError: { stage: 'DNS', code: 'NameResolutionFailure', count: 2 },
      source: { serial: { port: 'COM3', open: true } },
    },
  });
  assert.equal(good.status, 200);
  devices = (await admin.call('/devices')).body.devices;
  const d = devices[0];
  assert.equal(d.client.version, '1.2.8');
  assert.equal(d.client.cloudEnabled, true);
  assert.equal(d.client.lastError.stage, 'DNS');
  assert.equal(d.client.source.serial.port, 'COM3');
  assert.equal(d.clockSkewSec, 0, '本机时钟与云端一致时偏移为 0');
});

test('时间线：记录首次心跳、离线与恢复，可经接口取回', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const token = await registerDevice(h, admin);

  await beat(h, token);
  let tl = (await admin.call('/devices/lab-bms-01/timeline')).body;
  assert.equal(tl.events.some((e) => e.type === 'first-seen'), true, '必须记 first-seen');

  // 推进超过 3 个心跳周期（3×15s）→ 翻离线
  h.advance(46000);
  const devices = (await admin.call('/devices')).body.devices; // GET /devices 内部会 sweep
  assert.equal(devices[0].online, false);
  assert.equal(devices[0].missedBeats >= 3, true);

  tl = (await admin.call('/devices/lab-bms-01/timeline')).body;
  assert.equal(tl.events.some((e) => e.type === 'offline'), true, '必须记 offline');

  // 恢复心跳 → 记 online
  await beat(h, token);
  tl = (await admin.call('/devices/lab-bms-01/timeline')).body;
  assert.equal(tl.events.some((e) => e.type === 'online'), true, '必须记 online 恢复');
  assert.equal((await admin.call('/devices')).body.devices[0].online, true);
});

test('设备自助续期：编号不变、旧令牌即刻失效、新令牌可用', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const oldToken = await registerDevice(h, admin);
  assert.equal((await beat(h, oldToken)).status, 200);

  const res = await h.call('/device/refresh', 'POST', {}, { Authorization: `Bearer ${oldToken}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deviceId, 'lab-bms-01', '续期只换凭据，不换身份');
  const newToken = res.body.deviceToken;
  assert.equal(typeof newToken, 'string');
  assert.notEqual(newToken, oldToken);

  assert.equal((await beat(h, oldToken)).status, 401, '旧令牌必须立即失效');
  assert.equal((await beat(h, newToken)).status, 200, '新令牌必须可用');

  // 身份与授权范围都没变，只是凭据换了
  const devices = (await admin.call('/devices')).body.devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, 'lab-bms-01');
  assert.deepEqual(devices[0].allowedPacks, [1, 2]);
});

test('心跳限流不再卡在客户端极限：契约上限内不 429，超出才拒', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const token = await registerDevice(h, admin);
  // 回归点：上限曾经是 30/分钟，而客户端下限算下来正好 30/分钟，一次重试就 429。
  for (let i = 0; i < 30; i++) {
    assert.equal((await beat(h, token)).status, 200, `第 ${i + 1} 次心跳被限流（旧上限边界）`);
  }
  for (let i = 30; i < HEARTBEAT.ratePerMinute; i++) {
    const r = await beat(h, token);
    assert.equal(r.status, 200, `第 ${i + 1} 次心跳被限流（上限 ${HEARTBEAT.ratePerMinute}/分钟）`);
  }
  assert.equal((await beat(h, token)).status, 429, '超过契约上限必须拒绝，防止真的是滥用');
  // 心跳下限与上限必须对得上，否则加一次重试就会撞墙
  assert.equal(HEARTBEAT.minIntervalMs <= Math.floor(60000 / 20), true, '心跳下限必须明显高于「打满上限」的频率');
});

test('时间线只对有权观看该设备的人开放', async (t) => {
  const h = await harness(t);
  const admin = await h.setup();
  const token = await registerDevice(h, admin);
  await beat(h, token);
  // 未登录直接取时间线必须被拒（含主机名/内网地址等现场信息，不能公开）
  assert.equal((await h.call('/devices/lab-bms-01/timeline')).status, 401);
});
