import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealtimeApi } from './routes.mjs';
import { passwordHash, tokenHash } from './auth.mjs';
import { catalog, EQUIPMENT } from './experiment-contract.mjs';

const origin = 'https://experiment-null-display.test';
const password = 'fixture-password-only';
const token = 'fixture-only-device-token-' + 'x'.repeat(32);
const device = {
  deviceId: 'null-display-fixture', alias: '空显示值夹具', module: 'experiment',
  allowedEquipment: EQUIPMENT, deviceTokenHash: tokenHash(token), allowSimulation: true,
};

function snapshot(sequence = 1) {
  const definitions = catalog.points.filter(point => point.equipmentId === 'PLC');
  return {
    schemaVersion: 1, module: 'experiment', deviceId: device.deviceId,
    connectionSessionId: 'null-display-connection', acquisitionSessionId: 'null-display-acquisition',
    sequence, capturedUtc: '2026-10-03T08:00:00.0000000Z', source: 'serial', equipmentId: 'PLC',
    slave: definitions[0].slave,
    points: definitions.map(definition => ({
      id: definition.id, description: definition.metadata.Label, unit: definition.metadata.Unit,
      value: definition.metadata.Mode === 'U16 / I16' || definition.metadata.Mode === 'RAW' ? null : 0,
      rawValue: null, displayValue: definition.metadata.Mode === 'U16 / I16' ? 'U16=0 / I16=0' : '0',
      quality: 'good', observedUtc: '2026-10-03T08:00:00.0000000Z', acquisitionRound: 1,
      configVersion: 'catalog-1', addressZeroBased: definition.addressZeroBased,
      registerCount: definition.registerCount, decodeMode: definition.metadata.Mode,
    })),
  };
}

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pv-exp-null-display-'));
  const config = {
    enabled: true, registryDir: dir, publicOrigin: origin, maxViewers: 4,
    devices: [structuredClone(device)],
    users: [{ username: 'fixture-admin', role: 'admin', passwordHash: await passwordHash(password), devices: [device.deviceId] }],
  };
  let mono = 0;
  const api = createRealtimeApi({ config, clocks: { now: () => mono, wall: () => Date.parse('2026-10-03T08:00:00Z') + mono } });
  const server = createServer(async (req, res) => {
    if (!await api.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    api.close();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(root + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  const guest = await call('/api/realtime/auth/session');
  const login = await call('/api/realtime/auth/login', 'POST', { username: 'fixture-admin', password }, {
    Cookie: guest.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': guest.body.csrfToken,
  });
  assert.equal(login.status, 200);
  const userHeaders = {
    Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin, 'X-Bms-Csrf': login.body.csrfToken,
  };
  const userCall = (path, method = 'GET', body) => call(path, method, body, userHeaders);
  const viewer = await userCall('/api/experiment/viewers', 'POST', { deviceId: device.deviceId, equipmentIds: ['PLC'] });
  assert.equal(viewer.status, 201);
  const heartbeat = await call('/api/experiment/heartbeat', 'POST', {
    deviceId: device.deviceId, alias: device.alias, module: 'experiment', schemaVersion: 1,
  }, { Authorization: `Bearer ${token}` });
  assert.equal(heartbeat.status, 200);
  assert.ok(heartbeat.body.leaseSeconds > 0);
  const send = sample => call('/api/experiment/snapshots', 'POST', {
    subscriptionId: heartbeat.body.subscriptionId, snapshot: sample,
  }, { Authorization: `Bearer ${token}` });
  return { userCall, send };
}

test('授权租约接受 stale 空显示值，保留真实零值并将失败趋势值留空', async t => {
  const h = await harness(t);
  const mixed = snapshot();
  const stale = mixed.points.find(point => point.id === 'T1');
  stale.quality = 'stale';
  stale.value = null;
  stale.rawValue = null;
  stale.displayValue = null;
  const timeout = mixed.points.find(point => point.id === 'T2');
  timeout.quality = 'timeout';
  timeout.value = null;
  timeout.rawValue = null;
  timeout.displayValue = '采集超时';
  const zero = mixed.points.find(point => point.id === 'T3');
  zero.value = 0;
  zero.displayValue = '0';

  const rejectedGood = structuredClone(mixed);
  rejectedGood.points.find(point => point.id === 'T1').quality = 'good';
  assert.equal((await h.send(rejectedGood)).status, 400, 'good 质量不得用 null 显示值绕过契约');
  const rejectedUnknown = structuredClone(mixed);
  rejectedUnknown.points.find(point => point.id === 'T1').quality = 'vendor_unknown';
  assert.equal((await h.send(rejectedUnknown)).status, 400, '未知质量不得用 null 显示值绕过契约');

  const accepted = await h.send(mixed);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.accepted, true);
  const latest = await h.userCall('/api/experiment/devices/null-display-fixture/latest');
  assert.equal(latest.status, 200);
  const points = latest.body.snapshots[0].snapshot.points;
  assert.equal(points.find(point => point.id === 'T1').displayValue, null);
  assert.equal(points.find(point => point.id === 'T2').displayValue, '采集超时');
  assert.equal(points.find(point => point.id === 'T3').value, 0);

  const staleTrend = await h.userCall('/api/experiment/devices/null-display-fixture/trend?equipmentId=PLC&pointId=T1&source=serial');
  const zeroTrend = await h.userCall('/api/experiment/devices/null-display-fixture/trend?equipmentId=PLC&pointId=T3&source=serial');
  assert.equal(staleTrend.status, 200);
  assert.equal(staleTrend.body.points[0].quality, 'stale');
  assert.equal(staleTrend.body.points[0].value, null);
  const timeoutTrend = await h.userCall('/api/experiment/devices/null-display-fixture/trend?equipmentId=PLC&pointId=T2&source=serial');
  assert.equal(timeoutTrend.body.points[0].quality, 'timeout');
  assert.equal(timeoutTrend.body.points[0].value, null);
  assert.equal(zeroTrend.status, 200);
  assert.equal(zeroTrend.body.points[0].quality, 'good');
  assert.equal(zeroTrend.body.points[0].value, 0);
});
