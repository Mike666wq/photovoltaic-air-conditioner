import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, validateExperimentSnapshot } from './experiment-contract.mjs';

test('catalog-2 点位身份/绑定唯一且全目录倍率确认；旧待核准单位仍可上传', () => {
  assert.equal(catalog.catalogVersion, 'catalog-2');
  assert.equal(catalog.points.length, 37);
  const keys = catalog.points.map(point => `${point.equipmentId}/${point.id}`);
  assert.equal(new Set(keys).size, keys.length);
  assert(catalog.points.every(point => point.metadata.ScaleConfirmed === true && point.metadata.Scale === 1));
  assert(catalog.points.every(point => !point.metadata.Unit.includes('待核准')));
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
    points: [{ id: 'DU3', description: def.metadata.Label, unit: 'W · 倍率待核准', value: 1, rawValue: null, displayValue: '1', quality: 'good', observedUtc: '2026-10-01T00:00:00Z', acquisitionRound: 1, configVersion: 'catalog-1', addressZeroBased: 8196, registerCount: 2, decodeMode: 'FLOAT ABCD' }],
  };
  const accepted = validateExperimentSnapshot({ subscriptionId: 'subscription', snapshot }, device);
  assert.equal(accepted.points[0].unit, 'W · 倍率待核准');
});
