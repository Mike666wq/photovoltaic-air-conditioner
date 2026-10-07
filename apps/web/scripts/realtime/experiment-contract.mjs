import { readFileSync } from 'node:fs';
import { assert, object, identifier, integer, utcDate, BACKFILL_BATCH_MAX } from './contract.mjs';
export const catalog = JSON.parse(readFileSync(new URL('../../shared/experiment/point-contract.json', import.meta.url), 'utf8'));
export const EQUIPMENT = ['DS666', 'PLC', 'DDSU666', 'DJSF6682'];
const definitions = new Map(catalog.points.map((p) => [`${p.equipmentId}/${p.id}`, p]));
export function equipment(values, allowed = EQUIPMENT) {
  assert(Array.isArray(values) && values.length > 0 && values.length <= 16 && values.every((v) => typeof v === 'string'));
  const result = [...new Set(values)];
  assert(result.every((id) => allowed.includes(id)), 403, 'EQUIPMENT_FORBIDDEN', '未授权的实验仪器'); return result;
}
export function historyPoints(values, allowed = EQUIPMENT) {
  assert(Array.isArray(values) && values.length <= 1 && values.every((v) => typeof v === 'string' && v.length >= 3 && v.length <= 170), 400, 'HISTORY_SELECTION_INVALID', '每个观看页面最多选择一个历史趋势测点');
  const result = [...new Set(values)].sort();
  for (const selection of result) {
    const slash = selection.indexOf('/'), equipmentId = selection.slice(0, slash), pointId = selection.slice(slash + 1);
    assert(slash > 0 && !pointId.includes('/') && allowed.includes(equipmentId), 403, 'HISTORY_SELECTION_FORBIDDEN', '历史趋势选择未授权');
    const def = definitions.get(`${equipmentId}/${pointId}`);
    assert(def && def.metadata.Group !== '运行状态' && def.metadata.Group !== '诊断', 400, 'HISTORY_SELECTION_INVALID', '历史趋势只能选择连续量测点');
  }
  return result;
}
const text = (v, max) => typeof v === 'string' && v.length <= max;
export function validateExperimentSnapshot(body, device) {
  assert(object(body) && identifier(body.subscriptionId) && object(body.snapshot)); const s = body.snapshot;
  assert(s.schemaVersion === 1, 422, 'SCHEMA_UNSUPPORTED', '不支持的实验采样协议版本');
  assert(s.module === 'experiment' && s.deviceId === device.deviceId, 403, 'DEVICE_MISMATCH', '设备或模块身份不匹配');
  assert(device.allowedEquipment.includes(s.equipmentId), 403, 'EQUIPMENT_FORBIDDEN', '未授权的实验仪器');
  assert(['serial', 'simulation'].includes(s.source));
  assert(identifier(s.connectionSessionId) && identifier(s.acquisitionSessionId) && integer(s.sequence, 1, Number.MAX_SAFE_INTEGER) && utcDate(s.capturedUtc));
  assert(Array.isArray(s.points) && s.points.length > 0 && s.points.length <= 128);
  const seen = new Set();
  const points = s.points.map((p) => {
    assert(object(p)); const def = definitions.get(`${s.equipmentId}/${p.id}`);
    assert(def && !seen.has(p.id), 400, 'POINT_UNREGISTERED', '测点不在正式目录或重复'); seen.add(p.id);
    assert(s.slave === def.slave && p.addressZeroBased === def.addressZeroBased && p.registerCount === def.registerCount, 400, 'POINT_BINDING_MISMATCH', '测点站号或寄存器绑定不匹配');
    assert(text(p.description, 128) && text(p.unit, 64) && text(p.displayValue, 256) && text(p.quality, 64) && p.quality.length > 0 && identifier(p.configVersion) && text(p.decodeMode, 64));
    assert((p.value === null || (typeof p.value === 'number' && Number.isFinite(p.value))) && (p.rawValue === null || (typeof p.rawValue === 'number' && Number.isFinite(p.rawValue))));
    if (['timeout', 'protocol_exception', 'decode_error', 'error', 'stale'].includes(p.quality)) assert(p.value === null, 400, 'QUALITY_VALUE_MISMATCH', '失败或过期测点不得携带有效工程数值');
    assert(utcDate(p.observedUtc) && integer(p.acquisitionRound, 0, Number.MAX_SAFE_INTEGER));
    return Object.fromEntries(['id','description','unit','value','rawValue','displayValue','quality','observedUtc','acquisitionRound','configVersion','addressZeroBased','registerCount','decodeMode'].map((k)=>[k,p[k]]));
  });
  return { ...Object.fromEntries(['schemaVersion','module','deviceId','connectionSessionId','acquisitionSessionId','sequence','capturedUtc','source','equipmentId','slave'].map((k)=>[k,s[k]])), points };
}

export function validateExperimentBackfill(body, device) {
  assert(object(body) && identifier(body.subscriptionId));
  assert(body.schemaVersion === 1, 422, 'SCHEMA_UNSUPPORTED', '不支持的实验历史回填协议版本');
  assert(body.module === 'experiment', 400, 'MODULE_INVALID', '历史回填模块无效');
  assert(Array.isArray(body.points) && body.points.length >= 1 && body.points.length <= BACKFILL_BATCH_MAX, 400, 'BACKFILL_BATCH_INVALID', `单批历史回填必须包含1到${BACKFILL_BATCH_MAX}个观测`);
  const points = body.points.map((p) => {
    assert(object(p) && ['serial','simulation'].includes(p.source));
    assert(device.allowedEquipment.includes(p.equipmentId), 403, 'EQUIPMENT_FORBIDDEN', '历史回填包含未授权仪器');
    const def = definitions.get(`${p.equipmentId}/${p.id}`);
    assert(def, 400, 'POINT_UNREGISTERED', '历史回填测点不在正式目录');
    assert(identifier(p.connectionSessionId) && identifier(p.acquisitionSessionId));
    assert(utcDate(p.observedUtc) && integer(p.acquisitionRound, 0, Number.MAX_SAFE_INTEGER));
    assert(text(p.unit,64) && text(p.quality,64) && p.quality.length > 0 && identifier(p.configVersion));
    assert(p.value === null || (typeof p.value === 'number' && Number.isFinite(p.value)));
    if (['timeout','protocol_exception','decode_error','error','stale'].includes(p.quality)) assert(p.value === null, 400, 'QUALITY_VALUE_MISMATCH', '失败或过期测点不得携带有效工程数值');
    return Object.fromEntries(['source','equipmentId','id','connectionSessionId','acquisitionSessionId','observedUtc','value','quality','unit','configVersion','acquisitionRound'].map((k)=>[k,p[k]]));
  });
  return { subscriptionId: body.subscriptionId, points };
}
