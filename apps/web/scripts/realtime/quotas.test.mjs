import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRealtimeApi } from './routes.mjs';
import { loadConfig, passwordHash, tokenHash } from './auth.mjs';
import { catalog } from './experiment-contract.mjs';

const origin = 'https://quota.example.test';
const password = 'quota-test-password-12';
const bmsToken = 'quota-test-bms-device-token-32-bytes';
const experimentToken = 'quota-test-experiment-device-token';
const bmsId = 'quota-bms';
const experimentId = 'quota-experiment';

async function harness(t, overrides = {}) {
  let mono = 1000;
  const passwordDigest = await passwordHash(password);
  const config = {
    enabled: true,
    publicOrigin: origin,
    viewerMs: 3_600_000,
    browserRequestsPerMinute: 5000,
    devices: [
      { deviceId: bmsId, alias: '配额BMS', module: 'bms', allowedPacks: [1], allowedAddresses: [1], allowSimulation: false, deviceTokenHash: tokenHash(bmsToken) },
      { deviceId: experimentId, alias: '配额实验', module: 'experiment', allowedEquipment: ['PLC'], allowSimulation: false, deviceTokenHash: tokenHash(experimentToken) },
    ],
    users: Array.from({ length: 11 }, (_, i) => ({ username: `viewer-${String(i).padStart(2, '0')}`, passwordHash: passwordDigest, devices: [bmsId, experimentId], role: 'viewer' })),
    ...overrides,
  };
  const api = createRealtimeApi({ config, clocks: { now: () => mono, wall: () => Date.parse('2026-10-04T08:00:00Z') + mono } });
  const server = createServer(async (req, res) => { if (!(await api.handle(req, res))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { api.close(); server.closeAllConnections(); server.close(); });
  const raw = async (path, method = 'GET', body, headers = {}, signal) => {
    const response = await fetch(root + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    if (response.headers.get('content-type')?.includes('application/json')) return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json(), response };
    return { status: response.status, headers: response.headers, response };
  };
  const login = async (username) => {
    const guest = await raw('/api/realtime/auth/session');
    const guestCookie = guest.headers.get('set-cookie').split(';')[0];
    const logged = await raw('/api/realtime/auth/login', 'POST', { username, password }, { Cookie: guestCookie, Origin: origin, 'X-Bms-Csrf': guest.body.csrfToken });
    assert.equal(logged.status, 200);
    const headers = { Cookie: logged.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': logged.body.csrfToken };
    return { username, headers, call: (path, method = 'GET', body) => raw(path, method, body, headers) };
  };
  const create = (user, module, pageId, body = {}) => user.call(`/api/${module}/viewers`, 'POST', { deviceId: module === 'realtime' ? bmsId : experimentId, ...(module === 'realtime' ? { packs: [1] } : { equipmentIds: ['PLC'] }), ...(pageId === undefined ? {} : { pageId }), ...body });
  return { api, raw, login, create, advance: (ms) => { mono += ms; } };
}

test('跨模块按页面计数，最多10个账户、每账户4页、每页每模块一个租约，单模块可容纳40租约', async (t) => {
  const h = await harness(t);
  const first = await h.login('viewer-00');
  const firstLeases = [];
  for (let page = 0; page < 4; page++) {
    const pageId = `page-${page}`;
    const bms = await h.create(first, 'realtime', pageId), experiment = await h.create(first, 'experiment', pageId);
    assert.equal(bms.status, 201); assert.equal(experiment.status, 201);
    firstLeases.push({ module: 'realtime', id: bms.body.viewerId }, { module: 'experiment', id: experiment.body.viewerId });
  }
  assert.equal((await h.create(first, 'realtime', 'page-0')).body.error.code, 'PAGE_MODULE_EXISTS');
  assert.equal((await h.create(first, 'realtime', 'page-4')).body.error.code, 'VIEWER_LIMIT');
  const secondSession = await h.login('viewer-00');
  assert.equal((await h.create(secondSession, 'experiment', 'page-0')).body.error.code, 'PAGE_SESSION_CONFLICT');

  for (let account = 1; account < 10; account++) {
    const user = await h.login(`viewer-${String(account).padStart(2, '0')}`);
    h.advance(60_001); // 测试账户来自不同客户端IP；推进假钟越过登录IP限流窗口，观看租约设为1小时。
    for (let page = 0; page < 4; page++) {
      const pageId = `page-${page}`;
      assert.equal((await h.create(user, 'realtime', pageId)).status, 201);
      assert.equal((await h.create(user, 'experiment', pageId)).status, 201);
    }
  }
  assert.equal(h.api.state.viewers.size, 40);
  assert.equal(h.api.experiment.viewers.size, 40);
  const eleventh = await h.login('viewer-10');
  assert.equal((await h.create(eleventh, 'realtime', 'new-page')).body.error.code, 'ACTIVE_USER_LIMIT');
  for (const lease of firstLeases) assert.equal((await first.call(`/api/${lease.module}/viewers/${lease.id}`, 'DELETE')).status, 204);
  assert.equal((await h.create(eleventh, 'realtime', 'new-page')).status, 201);
});

test('无pageId旧客户端仍可建立四条租约，租约过期释放页面与账户名额', async (t) => {
  const h = await harness(t, { viewerMs: 45000 });
  const user = await h.login('viewer-00');
  for (let i = 0; i < 4; i++) assert.equal((await h.create(user, 'realtime')).status, 201);
  assert.equal((await h.create(user, 'realtime')).body.error.code, 'VIEWER_LIMIT');
  h.advance(45001);
  assert.equal((await h.create(user, 'realtime', 'after-expiry')).status, 201);
  assert.equal((await h.create(user, 'realtime', '', { packs: [1] })).body.error.code, 'PAGE_ID_INVALID');
});

test('SSE允许每账户8个模块流，同viewer重连替换旧流，第9条独立流被拒绝', async (t) => {
  const h = await harness(t);
  const user = await h.login('viewer-00');
  const leases = [];
  for (let page = 0; page < 4; page++) {
    const pageId = `sse-page-${page}`;
    leases.push({ module: 'realtime', ...(await h.create(user, 'realtime', pageId)).body });
    leases.push({ module: 'experiment', ...(await h.create(user, 'experiment', pageId)).body });
  }
  const aborts = leases.map(() => new AbortController());
  t.after(() => aborts.forEach(controller => controller.abort()));
  const connect = (lease, signal) => h.raw(`/api/${lease.module}/events?viewerId=${encodeURIComponent(lease.viewerId)}`, 'GET', undefined, user.headers, signal);
  const responses = [];
  for (let i = 0; i < leases.length; i++) {
    const response = await connect(leases[i], aborts[i].signal);
    assert.equal(response.status, 200);
    responses.push(response);
  }
  // 已存在的viewer重连先回收旧流，故满8条时仍可连接成功。
  const replacementAbort = new AbortController(); t.after(() => replacementAbort.abort());
  assert.equal((await connect(leases[0], replacementAbort.signal)).status, 200);

  // 绕过创建路由构造一条额外内部租约，单独验证SSE总量保护仍生效。
  const owner = user.headers.Cookie.split('=')[1];
  const ninth = h.api.state.createViewer(owner, bmsId, [1], user.username, null, 'sse-page-0');
  assert.equal((await connect({ module: 'realtime', ...ninth }, new AbortController().signal)).body.error.code, 'SSE_LIMIT');
});

test('四个双模块页面按1.2秒趋势刷新预算约2800请求/分钟且默认限流可承载', async (t) => {
  const h = await harness(t);
  const user = await h.login('viewer-00');
  for (let page = 0; page < 4; page++) {
    assert.equal((await h.create(user, 'realtime', `load-${page}`)).status, 201);
    assert.equal((await h.create(user, 'experiment', `load-${page}`)).status, 201);
  }
  const plcPoints = catalog.points.filter(point => point.equipmentId === 'PLC').slice(0, 11);
  assert.equal(plcPoints.length, 11);
  const queries = [
    ...plcPoints.map(point => `/api/experiment/devices/${experimentId}/trend?equipmentId=PLC&pointId=${encodeURIComponent(point.id)}&source=serial`),
    ...['voltage', 'current', 'soc'].map(metric => `/api/realtime/devices/${bmsId}/trend?pack=1&metric=${metric}&source=serial`),
  ];
  // 50轮代表约1分钟，每个页面每轮11条实验趋势与3条BMS趋势。
  for (let tick = 0; tick < 50; tick++) {
    const responses = await Promise.all(Array.from({ length: 4 }, () => queries.map(path => user.call(path))).flat());
    for (const response of responses) assert.equal(response.status, 200);
  }
});

test('浏览器请求每分钟上限可配置且超限继续返回429', async (t) => {
  const h = await harness(t, { browserRequestsPerMinute: 2 });
  const user = await h.login('viewer-00');
  assert.equal((await user.call('/api/realtime/devices')).status, 200);
  assert.equal((await user.call('/api/realtime/devices')).status, 200);
  assert.equal((await user.call('/api/realtime/devices')).body.error.code, 'RATE_LIMITED');
});

test('浏览器限流默认5000/min，可调至10000且拒绝超出范围的配置', () => {
  const env = { BMS_REALTIME_ENABLED: '1', BMS_REALTIME_REGISTRY_DIR: '/tmp/quota-registry', BMS_REALTIME_PUBLIC_ORIGIN: origin };
  assert.equal(loadConfig(env).browserRequestsPerMinute, 5000);
  assert.equal(loadConfig({ ...env, BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE: '10000' }).browserRequestsPerMinute, 10000);
  assert.throws(() => loadConfig({ ...env, BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE: '10001' }), /配置BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE无效/);
});
