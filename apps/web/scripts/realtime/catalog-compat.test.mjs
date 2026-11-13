import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, validateExperimentSnapshot } from './experiment-contract.mjs';

test('点表单一真源：点位身份/绑定唯一；倍率确认标记如实反映现场状态；旧待核准单位仍可上传', () => {
  // 单一真源 = 采集端 PointCatalog（解码权威），云端只消费，不再自行维护副本。
  // 版本号是内容指纹，所以用形状断言而不是写死某个哈希。
  assert.match(catalog.catalogVersion, /^catalog-4-[0-9A-F]{16}$/);
  assert.equal(catalog.points.length, 37);
  const keys = catalog.points.map(point => `${point.equipmentId}/${point.id}`);
  assert.equal(new Set(keys).size, keys.length);
  assert(catalog.points.every(point => !point.metadata.Unit.includes('待核准')));

  // 关键不变量：**不得伪造确认**。没做过现场核对的点必须标 false，
  // 且未确认的集合必须精确等于下面这三个 —— 多一个少一个都说明有人偷改了点表。
  const unconfirmed = catalog.points
    .filter(point => point.metadata.ScaleConfirmed !== true)
    .map(point => `${point.equipmentId}/${point.id}`)
    .sort();
  assert.deepEqual(unconfirmed, ['DDSU666/D9', 'DJSF6682/ZI6682', 'DJSF6682/ZW66822']);

  // 倍率非 1 的点必须显式声明，避免"是不是漏乘了"这种事故悄悄发生
  const scaled = catalog.points
    .filter(point => point.metadata.Scale !== 1)
    .map(point => `${point.equipmentId}/${point.id}=${point.metadata.Scale}`)
    .sort();
  assert.deepEqual(scaled, ['DJSF6682/ZI6682=0.001', 'DJSF6682/ZU6682=0.1']);
  for (const [id, address, count] of [['D1', 8192, 2], ['D2', 8194, 2], ['D3', 8196, 2], ['DU1', 8192, 2], ['DU2', 8194, 2], ['DU6', 8202, 2], ['ZU6682', 0, 1], ['ZI6682', 3, 1]]) {
    const equipmentId = id.startsWith('DU') ? 'DDSU666' : id.startsWith('ZU') || id.startsWith('ZI') ? 'DJSF6682' : 'DS666';
    const point = catalog.points.find(item => item.equipmentId === equipmentId && item.id === id);
    assert(point, `missing ${equipmentId}/${id}`);
    assert.equal(point.addressZeroBased, address);
    assert.equal(point.registerCount, count);
  }
  const device = { deviceId: 'fixture', allowedEquipment: ['DDSU666'] };
  const def = catalog.points.find(point => point.equipmentId === 'DDSU666' && point.id === 'DU3');
  const snapshot = {
    schemaVersion: 1, module: 'experiment', deviceId: 'fixture', connectionSessionId: 'connection', acquisitionSessionId: 'acquisition',
    sequence: 1, capturedUtc: '2026-10-01T00:00:00Z', source: 'serial', equipmentId: 'DDSU666', slave: 6,
    points: [{ id: 'DU3', description: def.metadata.Label, unit: 'kW · 倍率待核准', value: 1, rawValue: null, displayValue: '1', quality: 'good', observedUtc: '2026-10-01T00:00:00Z', acquisitionRound: 1, configVersion: 'catalog-1', addressZeroBased: 8196, registerCount: 2, decodeMode: 'FLOAT ABCD' }],
  };
  const accepted = validateExperimentSnapshot({ subscriptionId: 'subscription', snapshot }, device);
  assert.equal(accepted.points[0].unit, 'kW · 倍率待核准');
});
