// v1线协议与Windows客户端保持一致；这里只验证结构，不猜测电流方向和告警位。
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function assert(condition, status = 400, code = 'INVALID_REQUEST', message = '请求字段无效') {
  if (!condition) throw new ApiError(status, code, message);
}
export const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const integer = (v, min = -2147483648, max = 2147483647) => Number.isSafeInteger(v) && v >= min && v <= max;
export const identifier = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 128;
export const BACKFILL_SECONDS = 300;
export const BACKFILL_BATCH_MAX = 128;
export function utcDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(v)) return false;
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 19) === v.slice(0, 19);
}
export function packs(v, allowed) {
  assert(Array.isArray(v) && v.length >= 1 && v.length <= 16 && v.every((p) => integer(p, 1, 16)), 400);
  const result = [...new Set(v)].sort((a, b) => a - b);
  assert(result.every((p) => allowed.includes(p)), 403, 'PACK_FORBIDDEN', '没有此Pack的权限');
  return result;
}
export function validateSnapshot(body, device) {
  assert(object(body) && identifier(body.subscriptionId) && object(body.snapshot));
  const s = body.snapshot;
  assert(Number.isInteger(s.schemaVersion));
  assert(s.schemaVersion === 1, 422, 'SCHEMA_UNSUPPORTED', '不支持的采样协议版本');
  assert(s.deviceId === device.deviceId, 403, 'DEVICE_MISMATCH', '设备身份不匹配');
  assert(device.allowedPacks.includes(s.pack) && device.allowedAddresses.includes(s.address), 403, 'PACK_FORBIDDEN', '未注册的地址或Pack');
  assert(s.source === 'serial' || s.source === 'simulation');
  assert(identifier(s.connectionSessionId) && integer(s.sequence, 1, Number.MAX_SAFE_INTEGER));
  assert(integer(s.acquisitionRound, 0, Number.MAX_SAFE_INTEGER) && utcDate(s.capturedUtc));
  assert(s.periodSeconds == null || integer(s.periodSeconds, 1, 86400));
  for (const k of ['voltageCentivolts', 'remainingCentiAh', 'totalCentiAh', 'cycles']) assert(integer(s[k], 0));
  for (const k of ['currentCentiamps', 'socPercent', 'sohPercent', 'humidityPercent']) assert(integer(s[k]));
  assert(Array.isArray(s.cellsMillivolts) && s.cellsMillivolts.length <= 48 && s.cellsMillivolts.every((v) => integer(v, 0)));
  assert(Array.isArray(s.temperaturesCelsius) && s.temperaturesCelsius.length <= 32 && s.temperaturesCelsius.every((v) => integer(v)));
  assert(typeof s.alarmObservationAvailable === 'boolean');
  if (!s.alarmObservationAvailable) assert(s.alarmObservation === null);
  else {
    const a = s.alarmObservation;
    assert(object(a) && utcDate(a.observedUtc) && integer(a.acquisitionRound, 0, Number.MAX_SAFE_INTEGER) && a.pack === s.pack);
    assert(typeof a.payloadHex === 'string' && a.payloadHex.length > 0 && a.payloadHex.length <= 4096 && /^(?:[0-9a-fA-F]{2})+$/.test(a.payloadHex));
  }
  // 输出只白名单字段，避免额外内容进入SSE或内存缓存。
  return Object.fromEntries(['schemaVersion', 'deviceId', 'connectionSessionId', 'sequence', 'acquisitionRound', 'periodSeconds', 'capturedUtc', 'source', 'address', 'pack', 'voltageCentivolts', 'currentCentiamps', 'socPercent', 'sohPercent', 'remainingCentiAh', 'totalCentiAh', 'cycles', 'humidityPercent', 'cellsMillivolts', 'temperaturesCelsius', 'alarmObservationAvailable', 'alarmObservation'].filter((k) => k in s).map((k) => [k, s[k]]));
}

export function validateBmsBackfill(body, device) {
  assert(object(body) && identifier(body.subscriptionId));
  assert(body.schemaVersion === 1, 422, 'SCHEMA_UNSUPPORTED', '不支持的历史回填协议版本');
  assert(body.module === 'bms', 400, 'MODULE_INVALID', '历史回填模块无效');
  assert(Array.isArray(body.points) && body.points.length >= 1 && body.points.length <= BACKFILL_BATCH_MAX, 400, 'BACKFILL_BATCH_INVALID', `单批历史回填必须包含1到${BACKFILL_BATCH_MAX}个观测`);
  const points = body.points.map((p) => {
    assert(object(p) && ['serial', 'simulation'].includes(p.source));
    assert(device.allowedPacks.includes(p.pack) && device.allowedAddresses.includes(p.address), 403, 'PACK_FORBIDDEN', '历史回填包含未注册的地址或Pack');
    assert(identifier(p.connectionSessionId) && integer(p.sequence, 1, Number.MAX_SAFE_INTEGER) && utcDate(p.capturedUtc));
    assert(p.periodSeconds == null || integer(p.periodSeconds, 1, 86400));
    assert(integer(p.voltageCentivolts, 0) && integer(p.currentCentiamps) && integer(p.socPercent));
    return Object.fromEntries(['source', 'address', 'pack', 'connectionSessionId', 'sequence', 'capturedUtc', 'periodSeconds', 'voltageCentivolts', 'currentCentiamps', 'socPercent'].filter((k) => k in p).map((k) => [k, p[k]]));
  });
  return { subscriptionId: body.subscriptionId, points };
}
