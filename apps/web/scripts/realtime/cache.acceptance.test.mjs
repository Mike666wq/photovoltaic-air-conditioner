import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CacheCoordinator } from './cache-coordinator.mjs';
import { RealtimeState } from './state.mjs';
import { ExperimentState } from './experiment-state.mjs';
import { catalog, validateExperimentSnapshot } from './experiment-contract.mjs';
import { validateSnapshot } from './contract.mjs';

const HOUR = 60 * 60 * 1000;
const BASE = Date.parse('2026-10-03T08:00:00.000Z');
const bmsDevice = { deviceId: 'accept-bms', alias: 'BMS验收夹具', allowedPacks: [1], allowedAddresses: [1], allowSimulation: true };
const experimentDevice = { deviceId: 'accept-experiment', alias: '实验验收夹具', module: 'experiment', allowedEquipment: ['PLC'], allowSimulation: true };

function clockHarness(options = {}) {
  let mono = options.mono ?? 0;
  let wall = options.wall ?? BASE;
  const clocks = { now: () => mono, wall: () => wall };
  const config = {
    cacheMs: HOUR,
    maxPoints: 600,
    viewerMs: 45_000,
    maxViewers: 8,
    maxCachePoints: 10_000,
    maxCacheBytes: 10_000_000,
    devices: [bmsDevice, experimentDevice],
    ...options.config,
  };
  const coordinator = new CacheCoordinator(config, clocks);
  const bms = new RealtimeState({ ...config, coordinator, devices: [bmsDevice] }, clocks);
  const experiment = new ExperimentState({ ...config, coordinator, devices: [experimentDevice] }, clocks);
  return {
    config, coordinator, bms, experiment, clocks,
    get mono() { return mono; }, get wall() { return wall; },
    advance(ms) { mono += ms; wall += ms; },
    jumpWall(ms) { wall += ms; },
  };
}

function bmsSnapshot(patch = {}, wall = BASE) {
  return validateSnapshot({
    subscriptionId: 'lease-fixture',
    snapshot: {
      schemaVersion: 1,
      deviceId: bmsDevice.deviceId,
      connectionSessionId: 'bms-session-a',
      sequence: 1,
      acquisitionRound: 0,
      periodSeconds: 1,
      capturedUtc: new Date(wall).toISOString(),
      source: 'serial', address: 1, pack: 1,
      voltageCentivolts: 5321, currentCentiamps: -102, socPercent: 73,
      sohPercent: 99, remainingCentiAh: 2500, totalCentiAh: 5000, cycles: 12,
      humidityPercent: 40, cellsMillivolts: [3333], temperaturesCelsius: [21],
      alarmObservationAvailable: false, alarmObservation: null,
      ...patch,
    },
  }, bmsDevice);
}

function startBms(state, selected = [1], owner = 'owner-bms') {
  const viewer = state.createViewer(owner, bmsDevice.deviceId, selected);
  const lease = state.heartbeat(bmsDevice.deviceId);
  return { viewer, lease, owner };
}
function bmsHistoryPoint(patch = {}, wall = BASE - 60_000) {
  const s = bmsSnapshot(patch, wall);
  return Object.fromEntries(['source','address','pack','connectionSessionId','sequence','capturedUtc','periodSeconds','voltageCentivolts','currentCentiamps','socPercent'].map(key => [key, s[key]]));
}

function definition(pointId) {
  return catalog.points.find(point => point.equipmentId === 'PLC' && point.id === pointId);
}

function expPoint(pointId, patch = {}) {
  const def = definition(pointId);
  return {
    id: pointId,
    description: def.metadata.Label,
    unit: def.metadata.Unit,
    value: 5,
    rawValue: 5,
    displayValue: '5',
    quality: 'good',
    observedUtc: new Date(BASE).toISOString(),
    acquisitionRound: 1,
    configVersion: 'acceptance-catalog-1',
    addressZeroBased: def.addressZeroBased,
    registerCount: def.registerCount,
    decodeMode: def.metadata.Mode,
    ...patch,
  };
}

function expSnapshot(sequence, points, patch = {}, wall = BASE) {
  const def = definition(points[0].id);
  return validateExperimentSnapshot({
    subscriptionId: 'lease-fixture',
    snapshot: {
      schemaVersion: 1, module: 'experiment', deviceId: experimentDevice.deviceId,
      connectionSessionId: 'exp-connection-a', acquisitionSessionId: 'exp-acquisition-a',
      sequence, capturedUtc: new Date(wall).toISOString(), source: 'serial',
      equipmentId: 'PLC', slave: def.slave, points, ...patch,
    },
  }, experimentDevice);
}

function startExperiment(state, owner = 'owner-exp') {
  const viewer = state.createViewer(owner, experimentDevice.deviceId, ['PLC']);
  const lease = state.heartbeat(experimentDevice.deviceId);
  return { viewer, lease, owner };
}
function experimentHistoryPoint(pointId = 'T1', patch = {}, wall = BASE - 60_000) {
  const def = definition(pointId);
  return { source:'serial', equipmentId:'PLC', id:pointId, connectionSessionId:'local-exp-session', acquisitionSessionId:'local-exp-session', observedUtc:new Date(wall).toISOString(), value:5, quality:'good', unit:def.metadata.Unit, configVersion:'acceptance-catalog-1', acquisitionRound:1, ...patch };
}

function acceptBms(h, lease, patch = {}) {
  const snapshot = bmsSnapshot(patch, h.wall);
  return h.bms.accept(bmsDevice.deviceId, lease.subscriptionId, snapshot);
}

function acceptExperiment(h, lease, sequence, points, patch = {}) {
  const snapshot = expSnapshot(sequence, points, patch, h.wall);
  return h.experiment.accept(experimentDevice.deviceId, lease.subscriptionId, snapshot);
}

test('超过旧600点阈值时，每个真实BMS观测仍进入趋势与共享小时预算', () => {
  const h = clockHarness({ config: { maxCachePoints: 2_000 } });
  const { lease } = startBms(h.bms);
  for (let sequence = 1; sequence <= 725; sequence++) {
    acceptBms(h, lease, { sequence });
    h.advance(1);
  }

  const page = h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 2_000);
  assert.equal(page.points.length, 725);
  assert.deepEqual(page.points.map(point => point.sequence), Array.from({ length: 725 }, (_, i) => i + 1));
  assert.equal(h.coordinator.status().usedPoints, 725);
  assert.equal(page.hasMore, false);
});

test('BMS 5分钟Warm Start只写趋势、重试幂等且不污染实时会话', () => {
  const h = clockHarness(); const { lease } = startBms(h.bms);
  assert.equal(lease.backfillSeconds, 300);
  const points = [
    bmsHistoryPoint({ sequence: 10, voltageCentivolts: 5200 }, BASE - 4 * 60_000),
    bmsHistoryPoint({ sequence: 11, voltageCentivolts: 5300 }, BASE - 60_000),
  ];
  assert.deepEqual(h.bms.backfill(bmsDevice.deviceId, lease.subscriptionId, points), { accepted: true, added: 2 });
  assert.deepEqual(h.bms.backfill(bmsDevice.deviceId, lease.subscriptionId, points), { accepted: true, added: 0 });
  assert.deepEqual(h.bms.backfill(bmsDevice.deviceId, lease.subscriptionId, [points[0], points[0]]), { accepted: true, added: 0 });
  const duplicate = bmsHistoryPoint({ sequence: 13, voltageCentivolts: 5400 }, BASE - 30_000);
  assert.deepEqual(h.bms.backfill(bmsDevice.deviceId, lease.subscriptionId, [duplicate, duplicate]), { accepted: true, added: 1 });
  assert.equal(h.bms.latest(bmsDevice.deviceId, [1]).packs.length, 0);
  assert.equal(h.bms.device(bmsDevice.deviceId).currentSession, null);
  assert.equal(h.bms.device(bmsDevice.deviceId).watermarks.size, 0);
  assert.deepEqual(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10).points.map(p => p.value), [52, 53, 54]);
  assert.throws(() => h.bms.backfill(bmsDevice.deviceId, lease.subscriptionId, [bmsHistoryPoint({ sequence: 12 }, BASE - 300_001)]), error => error.code === 'BACKFILL_WINDOW');
  h.advance(20_000);
  const delayed = bmsHistoryPoint({ sequence: 14, voltageCentivolts: 5500 }, BASE - 299_999);
  assert.deepEqual(h.bms.backfill(bmsDevice.deviceId, lease.subscriptionId, [delayed]), { accepted: true, added: 1 });
  acceptBms(h, lease, { sequence: 1, connectionSessionId: 'live-session' });
  assert.equal(h.bms.latest(bmsDevice.deviceId, [1]).packs.length, 1);
  assert.equal(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10).points.length, 5);
});

test('实验 5分钟Warm Start保留失败断点且不污染latest或采集会话', () => {
  const h = clockHarness(); const { lease } = startExperiment(h.experiment);
  assert.equal(lease.backfillSeconds, 300);
  const points = [
    experimentHistoryPoint('T1', { value: 21.5, acquisitionRound: 1 }, BASE - 4 * 60_000),
    experimentHistoryPoint('T1', { value: null, quality: 'timeout', acquisitionRound: 2 }, BASE - 60_000),
  ];
  assert.deepEqual(h.experiment.backfill(experimentDevice.deviceId, lease.subscriptionId, points), { accepted: true, added: 2 });
  assert.deepEqual(h.experiment.backfill(experimentDevice.deviceId, lease.subscriptionId, points), { accepted: true, added: 0 });
  assert.deepEqual(h.experiment.backfill(experimentDevice.deviceId, lease.subscriptionId, [points[0], points[0]]), { accepted: true, added: 0 });
  const duplicate = experimentHistoryPoint('T1', { value: 23, acquisitionRound: 3 }, BASE - 30_000);
  assert.deepEqual(h.experiment.backfill(experimentDevice.deviceId, lease.subscriptionId, [duplicate, duplicate]), { accepted: true, added: 1 });
  assert.equal(h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots.length, 0);
  assert.equal(h.experiment.device(experimentDevice.deviceId).currentSession, null);
  assert.equal(h.experiment.device(experimentDevice.deviceId).watermarks.size, 0);
  assert.deepEqual(h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T1', null, 10).points.map(p => p.value), [21.5, null, 23]);
  h.advance(20_000);
  const delayed = experimentHistoryPoint('T1', { value: 24, acquisitionRound: 4 }, BASE - 299_999);
  assert.deepEqual(h.experiment.backfill(experimentDevice.deviceId, lease.subscriptionId, [delayed]), { accepted: true, added: 1 });
  acceptExperiment(h, lease, 1, [expPoint('T1')]);
  assert.equal(h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots.length, 1);
  assert.equal(h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T1', null, 10).points.length, 5);
});

test('观看结束后无观看心跳不发租约，缓存由单调观测TTL保留且不受墙钟跳变影响', () => {
  const h = clockHarness();
  const { viewer, lease, owner } = startBms(h.bms);
  acceptBms(h, lease, { sequence: 1 });
  h.bms.release(viewer.viewerId, owner);

  assert.deepEqual(h.bms.heartbeat(bmsDevice.deviceId), { subscriptionId: '', leaseSeconds: 0, requestedPacks: [], backfillSeconds: 0 });
  h.jumpWall(7 * 24 * HOUR);
  h.advance(HOUR - 1);
  const beforeExpiry = h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10);
  assert.equal(beforeExpiry.points.length, 1);
  assert.equal(h.coordinator.status().usedPoints, 1);
  assert.equal(h.coordinator.retained(bmsDevice.deviceId, h.mono), true);

  h.advance(1);
  assert.equal(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10).points.length, 0);
  assert.equal(h.coordinator.status().usedPoints, 0);
});

test('每台设备只按自己的观看保留历史，另一设备持续观看不会延长其TTL', () => {
  const h = clockHarness();
  const exp = startExperiment(h.experiment);
  acceptExperiment(h, exp.lease, 1, [expPoint('T1')]);
  h.experiment.release(exp.viewer.viewerId, exp.owner);

  const bms = startBms(h.bms);
  for (let elapsed = 0; elapsed < HOUR + 45_000; elapsed += 40_000) {
    h.advance(40_000);
    h.bms.renew(bms.viewer.viewerId, bms.owner, [1]);
    h.bms.heartbeat(bmsDevice.deviceId);
    h.experiment.sweep();
  }
  assert.equal(h.coordinator.retained(bmsDevice.deviceId, h.mono), true);
  assert.equal(h.coordinator.retained(experimentDevice.deviceId, h.mono), false);
  assert.equal(h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots.length, 0);
});

test('BMS和实验来源的最新样本以全局acceptedOrder区分同毫秒到达顺序', () => {
  const h = clockHarness();
  const bms = startBms(h.bms);
  acceptBms(h, bms.lease, { sequence: 1, source: 'serial', capturedUtc: new Date(h.wall).toISOString() });
  acceptBms(h, bms.lease, { sequence: 1, source: 'simulation', capturedUtc: new Date(h.wall).toISOString() });
  let bmsSamples = h.bms.latest(bmsDevice.deviceId, [1]).packs;
  const bmsSerialOrder = bmsSamples.find(item => item.snapshot.source === 'serial').acceptedOrder;
  const bmsSimulationOrder = bmsSamples.find(item => item.snapshot.source === 'simulation').acceptedOrder;
  assert(bmsSimulationOrder > bmsSerialOrder);
  const bmsTrend = h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10);
  assert.deepEqual([...new Set(bmsTrend.points.map(point => point.source))].sort(), ['serial', 'simulation']);
  assert(bmsTrend.points.every(point => point.connectionSessionId === 'bms-session-a'));
  assert.deepEqual(acceptBms(h, bms.lease, { sequence: 1, source: 'simulation', capturedUtc: new Date(h.wall).toISOString() }), { accepted: true });
  bmsSamples = h.bms.latest(bmsDevice.deviceId, [1]).packs;
  assert.equal(bmsSamples.find(item => item.snapshot.source === 'simulation').acceptedOrder, bmsSimulationOrder);
  const newerSerial = acceptBms(h, bms.lease, { sequence: 3, source: 'serial', capturedUtc: new Date(h.wall).toISOString() });
  const newerSerialOrder = h.bms.latest(bmsDevice.deviceId, [1]).packs.find(item => item.snapshot.source === 'serial').acceptedOrder;
  assert(newerSerialOrder > bmsSimulationOrder);
  assert.deepEqual(acceptBms(h, bms.lease, { sequence: 2, source: 'serial', capturedUtc: new Date(h.wall).toISOString() }), { accepted: true });
  assert.equal(h.bms.latest(bmsDevice.deviceId, [1]).packs.find(item => item.snapshot.source === 'serial').acceptedOrder, newerSerialOrder);
  assert.deepEqual(newerSerial, { accepted: true });

  const exp = startExperiment(h.experiment);
  const base = expSnapshot(1, [expPoint('T1')], { source: 'serial' }, h.wall);
  h.experiment.accept(experimentDevice.deviceId, exp.lease.subscriptionId, base);
  const simulation = expSnapshot(1, [expPoint('T1', { acquisitionRound: 2 })], { source: 'simulation' }, h.wall);
  h.experiment.accept(experimentDevice.deviceId, exp.lease.subscriptionId, simulation);
  const expSamples = h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots;
  const expSerialOrder = expSamples.find(item => item.snapshot.source === 'serial').acceptedOrder;
  const expSimulationOrder = expSamples.find(item => item.snapshot.source === 'simulation').acceptedOrder;
  assert(expSimulationOrder > expSerialOrder);
  const expTrend = h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T1', null, 10);
  assert.deepEqual([...new Set(expTrend.points.map(point => point.source))].sort(), ['serial', 'simulation']);
  assert(expTrend.points.every(point => point.equipmentId === 'PLC' && point.connectionSessionId === 'exp-connection-a'));
  h.experiment.accept(experimentDevice.deviceId, exp.lease.subscriptionId, simulation);
  assert.equal(h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots.find(item => item.snapshot.source === 'simulation').acceptedOrder, expSimulationOrder);
  const newerSimulation = expSnapshot(3, [expPoint('T1', { acquisitionRound: 3, observedUtc: new Date(h.wall + 1000).toISOString() })], { source: 'simulation', capturedUtc: new Date(h.wall + 1000).toISOString() }, h.wall + 1000);
  assert.deepEqual(h.experiment.accept(experimentDevice.deviceId, exp.lease.subscriptionId, newerSimulation), { accepted: true });
  const newerSimulationOrder = h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots.find(item => item.snapshot.source === 'simulation').acceptedOrder;
  assert(newerSimulationOrder > expSimulationOrder);
  assert.deepEqual(h.experiment.accept(experimentDevice.deviceId, exp.lease.subscriptionId, simulation), { accepted: true });
  assert.equal(h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots.find(item => item.snapshot.source === 'simulation').acceptedOrder, newerSimulationOrder);

  h.bms.release(bms.viewer.viewerId, bms.owner); h.experiment.release(exp.viewer.viewerId, exp.owner);
  h.advance(HOUR - 1);
  assert.equal(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10).points.length, 3);
  assert.equal(h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T1', null, 10).points.length, 3);
  h.advance(1);
  assert.equal(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 10).points.length, 0);
  assert.equal(h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T1', null, 10).points.length, 0);
});

test('趋势游标按稳定序号分页2000点，过期前缀不会造成缺页或重复', () => {
  const h = clockHarness({ config: { maxCachePoints: 5_000 } });
  const { lease } = startBms(h.bms);
  const expiredPrefix = 7;
  const livePoints = 2_005;
  const total = expiredPrefix + livePoints;
  for (let sequence = 1; sequence <= total; sequence++) {
    const age = sequence <= expiredPrefix ? HOUR - 1 : 0;
    acceptBms(h, lease, { sequence, capturedUtc: new Date(h.wall - age).toISOString() });
  }
  h.advance(5);

  const first = h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 2_000);
  assert.equal(first.points.length, 2_000);
  assert.equal(first.points[0].periodSeconds, 1, '趋势观测应逐点保留声明周期');
  assert.equal(first.hasMore, true);
  const second = h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 2_000, null, first.nextCursor);
  assert.equal(second.points.length, 5);
  assert.equal(second.hasMore, false);
  assert.deepEqual([...first.points, ...second.points].map(point => point.sequence), Array.from({ length: livePoints }, (_, i) => i + expiredPrefix + 1));
});

test('序号空洞、来源和连接会话切换均保留各自有效历史', () => {
  const h = clockHarness();
  const { viewer, lease } = startBms(h.bms);
  acceptBms(h, lease, { sequence: 1 });
  acceptBms(h, lease, { sequence: 3 });
  acceptBms(h, lease, { sequence: 2 }); // 到达更晚的旧序号不能覆盖最新值，也不能造出趋势点。
  assert.deepEqual(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 20, 'serial').points.map(p => p.sequence), [1, 3]);

  h.advance(45_001);
  const next = startBms(h.bms);
  const nextLease = next.lease;
  acceptBms(h, nextLease, { sequence: 1, connectionSessionId: 'bms-session-b', capturedUtc: new Date(h.wall).toISOString() });
  acceptBms(h, nextLease, { sequence: 1, source: 'simulation', connectionSessionId: 'bms-session-b', capturedUtc: new Date(h.wall).toISOString() });
  assert.deepEqual(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 20, 'serial').points.map(p => `${p.connectionSessionId}:${p.sequence}`), ['bms-session-a:1', 'bms-session-a:3', 'bms-session-b:1']);
  assert.deepEqual(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 20, 'simulation').points.map(p => p.sequence), [1]);
  assert.equal(h.bms.trend(bmsDevice.deviceId, 1, 'voltage', 20, 'serial').points.at(-1).periodSeconds, 1);
  h.bms.release(next.viewer.viewerId, next.owner);
});

test('实验点新观测即使数值相同也入趋势，旧合并点不被快照重放刷新寿命', () => {
  const h = clockHarness();
  const { lease } = startExperiment(h.experiment);
  const t1 = expPoint('T1', { value: 5, rawValue: 5 });
  const t0 = expPoint('T0', { value: 1, rawValue: 1 });
  acceptExperiment(h, lease, 1, [t1, t0]);

  h.advance(10_000);
  const newerT0 = expPoint('T0', { value: 1, rawValue: 1, observedUtc: new Date(h.wall).toISOString(), acquisitionRound: 2 });
  acceptExperiment(h, lease, 3, [t1, newerT0]);

  const t1Trend = h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T1', 'serial', 20);
  const t0Trend = h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T0', 'serial', 20);
  assert.equal(t1Trend.points.length, 1);
  assert.equal(t0Trend.points.length, 2);
  assert.equal(t0Trend.points[1].value, 1);
  assert.equal(t0Trend.points[1].observedUtc, newerT0.observedUtc);
  const latest = h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots[0].snapshot.points;
  assert.equal(latest.find(point => point.id === 'T1').ageMs, 10_000);
});

test('共享容量失败不提交快照、水位或新会话；修复容量后相同序号可重试成功', () => {
  const h = clockHarness({ config: { maxCachePoints: 1 } });
  const { lease } = startExperiment(h.experiment);
  const first = expPoint('T1');
  acceptExperiment(h, lease, 1, [first]);
  h.advance(45_001);
  const next = startExperiment(h.experiment);
  const before = h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots[0];
  const device = h.experiment.device(experimentDevice.deviceId);
  const oldSession = device.currentSession;
  const oldSeen = device.sessionSeen;
  const oldWatermark = device.watermarks.get('exp-connection-a/serial/PLC');
  const nextAcceptedOrder = h.coordinator.nextAcceptedOrder;
  const attempted = expPoint('T0', { observedUtc: new Date(h.wall).toISOString(), acquisitionRound: 2 });
  const second = expSnapshot(1, [attempted], { connectionSessionId: 'exp-connection-b', acquisitionSessionId: 'exp-acquisition-b' }, h.wall);

  assert.throws(() => h.experiment.accept(experimentDevice.deviceId, next.lease.subscriptionId, second), error => error.status === 503 && error.code === 'CACHE_CAPACITY_EXCEEDED');
  assert.equal(device.currentSession, oldSession);
  assert.equal(device.sessionSeen, oldSeen);
  assert.equal(device.watermarks.get('exp-connection-a/serial/PLC'), oldWatermark);
  assert.equal(h.coordinator.nextAcceptedOrder, nextAcceptedOrder);
  assert.equal(device.watermarks.has(`exp-connection-b/serial/PLC`), false);
  assert.deepEqual(h.experiment.latest(experimentDevice.deviceId, ['PLC']).snapshots[0].snapshot, before.snapshot);
  assert.equal(h.coordinator.status().usedPoints, 1);

  h.coordinator.release([...h.coordinator.entries.keys()]);
  assert.deepEqual(h.experiment.accept(experimentDevice.deviceId, next.lease.subscriptionId, second), { accepted: true });
  assert.equal(device.currentSession, 'exp-connection-b');
  assert.equal(device.watermarks.get('exp-connection-b/serial/PLC').sequence, 1);
  assert.equal(h.experiment.trend(experimentDevice.deviceId, 'PLC', 'T0', 'serial', 10).points.length, 1);
});

test('默认生产时钟共享performance单调时间原点，墙钟UTC只用于观测标签', () => {
  const coordinator = new CacheCoordinator({ cacheMs: HOUR, maxCachePoints: 20, maxCacheBytes: 20_000 });
  const state = new RealtimeState({ devices: [bmsDevice], cacheMs: HOUR, viewerMs: 45_000, maxViewers: 4, coordinator });
  const start = performance.now();
  assert(Math.abs(state.now() - coordinator.now()) < 1_000);
  const { lease } = startBms(state);
  const snapshot = bmsSnapshot({}, Date.now());
  state.accept(bmsDevice.deviceId, lease.subscriptionId, snapshot);
  const item = [...state.device(bmsDevice.deviceId).latest.values()][0];
  assert.equal(coordinator.hasKey(item.cacheKey), true);
  assert(item.expiresAt > coordinator.now());
  assert(Math.abs(item.mono - start) < 1_000);
  assert(Number.isFinite(Date.parse(item.receivedAt)));
});
