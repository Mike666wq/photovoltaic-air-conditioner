import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealtimeApi } from './routes.mjs';
import { passwordHash, tokenHash } from './auth.mjs';
import { catalog } from './experiment-contract.mjs';

const origin = 'https://diagnostics.test';
const password = 'diagnostics-test-password';
const tokens = { 'exp-a': 'diagnostics-device-token-a-1234567890', 'exp-b': 'diagnostics-device-token-b-1234567890' };
const registrations = Object.entries(tokens).map(([deviceId, token]) => ({
  deviceId, alias: deviceId, module: 'experiment', allowedEquipment: ['PLC'], allowSimulation: false, deviceTokenHash: tokenHash(token),
}));

async function harness(t) {
  let mono = 0;
  const dir = mkdtempSync(join(tmpdir(), 'pv-exp-diagnostics-'));
  const config = {
    enabled: true, registryDir: dir, publicOrigin: origin, maxViewers: 4, maxCachePoints: 100,
    devices: structuredClone(registrations),
    users: [{ username: 'admin-diagnostics', role: 'admin', passwordHash: await passwordHash(password), devices: registrations.map(d => d.deviceId) }],
  };
  const api = createRealtimeApi({ config, clocks: { now: () => mono, wall: () => Date.parse('2026-10-28T00:00:00Z') + mono } });
  const server = createServer(async (req, res) => { if (!await api.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { api.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(root + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  const guest = await call('/api/experiment/auth/session');
  const login = await call('/api/experiment/auth/login', 'POST', { username: 'admin-diagnostics', password }, {
    Cookie: guest.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': guest.body.csrfToken,
  });
  assert.equal(login.status, 200);
  const user = {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': login.body.csrfToken },
    call: (path, method = 'GET', body) => call(path, method, body, { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': login.body.csrfToken }),
  };
  const start = async (deviceId, pageId) => (await user.call('/api/experiment/viewers', 'POST', { deviceId, equipmentIds: ['PLC'], pageId })).body;
  const beat = async deviceId => {
    const device = registrations.find(d => d.deviceId === deviceId);
    return call('/api/experiment/heartbeat', 'POST', { deviceId, alias: device.alias, module: 'experiment', schemaVersion: 1 }, { Authorization: `Bearer ${tokens[deviceId]}` });
  };
  const point = (id, sequence) => {
    const definition = catalog.points.find(item => item.equipmentId === 'PLC' && item.id === id);
    return { id, description: definition.metadata.Label, unit: definition.metadata.Unit, value: 20 + sequence, rawValue: null, displayValue: String(20 + sequence), quality: 'good', observedUtc: '2026-10-28T00:00:00Z', acquisitionRound: sequence, configVersion: 'catalog-2', addressZeroBased: definition.addressZeroBased, registerCount: definition.registerCount, decodeMode: definition.metadata.Mode };
  };
  const snapshot = (deviceId, subscriptionId, id = 'T1', sequence = 1, patch = {}) => ({
    subscriptionId,
    snapshot: { schemaVersion: 1, module: 'experiment', deviceId, connectionSessionId: `connection-${deviceId}`, acquisitionSessionId: `acquisition-${deviceId}`, sequence, capturedUtc: '2026-10-28T00:00:00Z', source: 'serial', equipmentId: 'PLC', slave: 2, points: [point(id, sequence)], ...patch },
  });
  const send = (deviceId, body, raw = false) => call('/api/experiment/snapshots', 'POST', raw ? body : body, raw ? { Authorization: `Bearer ${tokens[deviceId]}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${tokens[deviceId]}` });
  return { api, root, call, user, start, beat, snapshot, send };
}

async function readUntil(reader, pattern, initial = '') {
  let text = initial;
  while (!pattern.test(text)) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'SSE stream ended before expected event');
    text += new TextDecoder().decode(value);
  }
  return text;
}

test('实验快照诊断按设备隔离，记录成功、解析/校验/租约/容量拒绝并经latest与SSE返回', { timeout: 10000 }, async t => {
  const h = await harness(t), viewerA = await h.start('exp-a', 'page-a'), viewerB = await h.start('exp-b', 'page-b');
  const leaseA = (await h.beat('exp-a')).body, leaseB = (await h.beat('exp-b')).body;
  const abort = new AbortController();
  const sse = await fetch(`${h.root}/api/experiment/events?viewerId=${viewerA.viewerId}`, { headers: h.user.headers, signal: abort.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const initial = await readUntil(reader, /event: device-status\ndata:/);
  const initialPayload = JSON.parse(initial.match(/event: device-status\ndata: (.+)\n\n/)[1]);
  assert.deepEqual(initialPayload.uploadStatus, { lastAttemptAt: null, lastAcceptedAt: null, lastRejectedAt: null, acceptedRequests: 0, rejectedRequests: 0, lastError: null });

  assert.equal((await h.send('exp-a', h.snapshot('exp-a', leaseA.subscriptionId))).status, 200);
  const acceptedSse = await readUntil(reader, /"acceptedRequests":1/);
  assert.match(acceptedSse, /"lastError":null/);
  let latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.acceptedRequests, 1);
  assert.equal(latestA.uploadStatus.rejectedRequests, 0);
  assert.equal(latestA.uploadStatus.lastAttemptAt, latestA.uploadStatus.lastAcceptedAt);
  assert.equal(latestA.uploadStatus.lastError, null);

  assert.equal((await h.send('exp-b', h.snapshot('exp-b', leaseB.subscriptionId))).status, 200);
  const latestB = (await h.user.call('/api/experiment/devices/exp-b/latest')).body;
  assert.equal(latestB.uploadStatus.acceptedRequests, 1);
  assert.equal(latestB.uploadStatus.rejectedRequests, 0);

  const validation = h.snapshot('exp-a', leaseA.subscriptionId, 'T1', 2, { schemaVersion: 2 });
  const validationResult = await h.send('exp-a', validation);
  assert.equal(validationResult.status, 422);
  assert.equal(validationResult.body.error.code, 'SCHEMA_UNSUPPORTED');
  await readUntil(reader, /"code":"SCHEMA_UNSUPPORTED"/);
  latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.acceptedRequests, 1);
  assert.equal(latestA.uploadStatus.rejectedRequests, 1);
  assert.equal(latestA.uploadStatus.lastError.status, 422);
  assert.equal(latestA.uploadStatus.lastError.code, 'SCHEMA_UNSUPPORTED');
  assert.equal(latestA.uploadStatus.lastError.message, '不支持的实验采样协议版本');
  assert.equal(latestA.uploadStatus.lastRejectedAt, latestA.uploadStatus.lastAttemptAt);

  assert.equal((await h.send('exp-a', h.snapshot('exp-a', leaseA.subscriptionId, 'T1', 3))).status, 200);
  const recoveredSse = await readUntil(reader, /"acceptedRequests":2/);
  assert.match(recoveredSse, /"lastError":null/);
  latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.acceptedRequests, 2);
  assert.equal(latestA.uploadStatus.rejectedRequests, 1);
  assert.notEqual(latestA.uploadStatus.lastRejectedAt, null);
  assert.equal(latestA.uploadStatus.lastError, null, '成功状态事件立即清除上次拒绝错误');

  const malformed = await h.send('exp-a', '{"privateBodyCanary":"must-not-be-stored"', true);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'JSON_INVALID');
  latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.rejectedRequests, 2);
  assert.equal(latestA.uploadStatus.lastError.code, 'JSON_INVALID');
  assert(!JSON.stringify(latestA.uploadStatus).includes('privateBodyCanary'));

  const noLease = await h.send('exp-a', h.snapshot('exp-a', 'wrong-subscription', 'T1', 3));
  assert.equal(noLease.status, 409);
  assert.equal(noLease.body.error.code, 'LEASE_EXPIRED');
  latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.rejectedRequests, 3);
  assert.equal(latestA.uploadStatus.lastError.code, 'LEASE_EXPIRED');

  h.api.experiment.coordinator.maxPoints = 2;
  const capacity = await h.send('exp-a', h.snapshot('exp-a', leaseA.subscriptionId, 'T2', 4));
  assert.equal(capacity.status, 503);
  assert.equal(capacity.body.error.code, 'CACHE_CAPACITY_EXCEEDED');
  latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.rejectedRequests, 4);
  assert.equal(latestA.uploadStatus.lastError.code, 'CACHE_CAPACITY_EXCEEDED');
  const sseText = await readUntil(reader, /"code":"CACHE_CAPACITY_EXCEEDED"/);
  assert.match(sseText, /"uploadStatus":\{"lastAttemptAt":"/);
  assert.match(sseText, /"rejectedRequests":4/);

  h.api.experiment.coordinator.maxPoints = 100;
  assert.equal((await h.send('exp-a', h.snapshot('exp-a', leaseA.subscriptionId, 'T1', 5))).status, 200);
  latestA = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestA.uploadStatus.acceptedRequests, 3);
  assert.equal(latestA.uploadStatus.rejectedRequests, 4);
  assert.notEqual(latestA.uploadStatus.lastRejectedAt, null);
  assert.equal(latestA.uploadStatus.lastError, null, '后续成功清除错误但保留上次拒绝时间');

  const unauthorized = await h.call('/api/experiment/snapshots', 'POST', h.snapshot('exp-b', leaseB.subscriptionId));
  assert.equal(unauthorized.status, 401);
  const latestBAfterUnauthorized = (await h.user.call('/api/experiment/devices/exp-b/latest')).body;
  assert.deepEqual(latestBAfterUnauthorized.uploadStatus, latestB.uploadStatus, '未鉴权上传不污染目标设备诊断');
  const latestAAfterB = (await h.user.call('/api/experiment/devices/exp-a/latest')).body;
  assert.equal(latestAAfterB.uploadStatus.rejectedRequests, 4, '设备B请求不得修改设备A诊断');
  abort.abort();
});
