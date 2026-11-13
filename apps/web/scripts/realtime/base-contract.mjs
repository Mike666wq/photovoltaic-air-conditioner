// @generated 由 _base/contract/contract.mjs 生成，请勿手改。
// @source-sha256 8ccff11ee353372c3dc81214b29dcd50d3567e56395fa2c69e0a7e3a2479b896
// @sync node apps/web/scripts/sync-base-contract.mjs --write
// @end-header
// ============================================================
// 基座契约真相源 v1
// ------------------------------------------------------------
// 这是三端（云端 photovoltaic-air-conditioner / BMS 端 BmsSerialDemo /
// 实验端 ExperimentMonitorDemo）之间唯一的机器可读契约。
//
// 规则：任何一端改动载荷字段、单位、枚举或限额，必须先改本文件，
// 再让 conformance/check.mjs 通过，最后才改实现。
//
// 零依赖：纯 ESM，不引任何包，node 直接跑。
// ============================================================

export const SCHEMA_VERSION = 1;

// ---------- 路由 ----------
// 服务端只认这三个前缀，prefix -> module 一一对应。
export const MODULES = ['bms', 'experiment'];

export const ROUTES = {
  heartbeat: (module) => `/api/${module === 'bms' ? 'realtime' : module}/heartbeat`,
  snapshots: (module) => `/api/${module === 'bms' ? 'realtime' : module}/snapshots`,
  backfill:  (module) => `/api/${module === 'bms' ? 'realtime' : module}/backfill`,
};

// 前缀 -> module。monitoring 是 bms 的历史别名，不得承载 experiment。
export const PREFIX_MODULE = {
  '/api/realtime': 'bms',
  '/api/experiment': 'experiment',
  '/api/monitoring': 'bms',
};

// ---------- 传输限额（硬约束，不可配置） ----------
export const TRANSPORT = {
  requestTimeoutMs: 5000,        // 单次请求整体时限
  responseMaxBytes: 65536,       // 响应体上限
  backfillBodyMaxBytes: 131072,  // 回填正文上限（其他 JSON 接口仍是 64KiB）
  httpsOnly: true,
  allowRedirect: false,
  forbidUserInfo: true,
};

// ---------- 租约 ----------
export const LEASE = {
  leaseSecondsMin: 0,
  leaseSecondsMax: 3600,
  requestedPacksMaxItems: 16,
  requestedPackMin: 1,
  requestedPackMax: 16,
  requestedDevicesMaxItems: 16,
  requestedDeviceIdMaxLen: 80,
  requestedHistoryPointsMaxItems: 64,
  requestedHistoryPointMaxLen: 170, // 形如 "equipmentId/pointId"
  backfillSecondsMin: 0,
  backfillSecondsMax: 300,
  backfillBatchMaxPoints: 128,   // 单批回填点数（字节上限另见 TRANSPORT）
  viewerTtlSeconds: 45,
  renewAfterSeconds: 15,
};

// ---------- 并发限额（服务端写死，不可配） ----------
export const QUOTAS = {
  maxActiveUsers: 10,
  maxViewerLeasesPerModule: 40,
  maxPagesPerUser: 4,
  maxSsePerUser: 8,
};

// ---------- 缓存 ----------
export const CACHE = {
  ttlMs: 3600000,          // 1h，代码固定
  maxPointsDefault: 500000,
  maxBytesDefault: 134217728, // 128MiB
  pointBytesEstimate: 1024,
  trendLimitMin: 1,
  trendLimitMax: 2000,
};

// ---------- 时间 ----------
// 规范：一律 UTC ISO-8601；出网统一 7 位小数（.NET "o" / JS toISOString 之后再补）。
export const TIME = {
  format: 'utc-iso8601',
  fractionDigits: 7,
};

// ---------- 单位（全链路整数，禁止浮点跨端） ----------
export const BMS_UNITS = {
  voltageCentivolts: 'cV',   // 云端 /100 显示为 V
  currentCentiamps: 'cA',    // 有符号，充放由固件定
  remainingCentiAh: 'cAh',
  totalCentiAh: 'cAh',
  cellsMillivolts: 'mV',
  temperaturesCelsius: '℃',
  socPercent: '%',
  sohPercent: '%',
  humidityPercent: '%',
};

// ---------- 质量枚举 ----------
// 本地采集端 7 个值（Quality.cs），出网时多 2 个（云端/传输层生成）。
export const QUALITY = {
  local: ['good', 'timeout', 'protocol_exception', 'decode_error', 'error', 'ambiguous', 'skipped'],
  wireOnly: ['stale', 'unknown'],
  // 这些质量下 value 必须是 null，不得填 0
  mustBeNull: ['timeout', 'protocol_exception', 'decode_error', 'error', 'stale'],
};

// ---------- BMS 快照字段表 ----------
// 顺序无关；云端按白名单回吐，多余字段丢弃。
export const BMS_SNAPSHOT = {
  required: [
    'schemaVersion', 'deviceId', 'connectionSessionId', 'sequence',
    'acquisitionRound', 'capturedUtc', 'source', 'address', 'pack',
    'voltageCentivolts', 'currentCentiamps', 'socPercent', 'sohPercent',
    'remainingCentiAh', 'totalCentiAh', 'cycles', 'humidityPercent',
    'cellsMillivolts', 'temperaturesCelsius', 'alarmObservationAvailable',
  ],
  optional: ['periodSeconds', 'alarmObservation'],
  limits: {
    addressMin: 1, addressMax: 255,
    packMin: 1, packMax: 16,
    cellsMax: 48,
    temperaturesMax: 32,
    periodSecondsMin: 1, periodSecondsMax: 86400,
  },
  alarm: { required: ['observedUtc', 'acquisitionRound', 'pack', 'payloadHex'], payloadHexMaxLen: 4096 },
};

// ---------- 实验快照字段表 ----------
export const EXPERIMENT_SNAPSHOT = {
  required: [
    'schemaVersion', 'module', 'deviceId', 'connectionSessionId',
    'acquisitionSessionId', 'sequence', 'capturedUtc', 'source',
    'equipmentId', 'slave', 'points',
  ],
  maxPointsPerSnapshot: 128,
  point: {
    required: [
      'id', 'description', 'unit', 'value', 'rawValue', 'displayValue',
      'quality', 'observedUtc', 'acquisitionRound', 'configVersion',
      'addressZeroBased', 'registerCount', 'decodeMode',
    ],
    optional: ['roundStartedUtc'],
    limits: { descriptionMaxLen: 128, unitMaxLen: 64, qualityMaxLen: 64, displayValueMaxLen: 256, configVersionMaxLen: 128 },
  },
};

// ---------- 幂等键公式（规范，不是建议） ----------
// 客户端不需要自己算，服务端按此去重；客户端必须保证同一次重试沿用同一 sequence。
export const IDEMPOTENCY = {
  bmsSnapshot: 'deviceId|connectionSessionId|source/address/pack|sequence',
  bmsBackfill: 'deviceId|bms-backfill|sha256(source,address,pack,session,sequence,capturedUtc,periodSeconds,voltage,current,soc)',
  experimentSnapshot: 'deviceId|source|equipmentId|pointId|acquisitionSessionId|configVersion|acquisitionRound|observedUtc|sha256(quality,value,rawValue,displayValue,unit,description)',
  experimentBackfill: 'deviceId|experiment-backfill|sha256(source,equipmentId,id,conn,acqSession,observedUtc,value,quality,unit,configVersion,round)',
};

// ============================================================
// 校验器
// ============================================================

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const inRange = (v, min, max) => typeof v === 'number' && v >= min && v <= max;
const isUtcIso = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v);

function checkRequired(obj, fields, where, errors) {
  for (const f of fields) {
    if (obj[f] === undefined) errors.push(`${where}: 缺必填字段 "${f}"`);
  }
}

function checkNoUnknown(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: 未知字段 "${k}"（白名单外，跨端会被丢弃）`);
  }
}

function checkEnum(v, allowed, where, errors) {
  if (!allowed.includes(v)) errors.push(`${where}: "${v}" 不在枚举 [${allowed.join('|')}] 内`);
}

// --- 心跳请求 ---
export function validateHeartbeatRequest(body, module) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['heartbeat: 不是对象'];
  checkRequired(body, ['deviceId', 'alias'], 'heartbeat', errors);
  if (typeof body.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.deviceId))
    errors.push('heartbeat: deviceId 必须匹配 ^[A-Za-z0-9_-]{1,80}$');
  if (typeof body.alias !== 'string' || body.alias.length > 128)
    errors.push('heartbeat: alias 必须是非空字符串且 ≤128');
  if (module === 'experiment') {
    if (body.module !== 'experiment') errors.push('heartbeat: 实验端心跳必须带 module="experiment"');
    if (body.schemaVersion !== SCHEMA_VERSION) errors.push(`heartbeat: schemaVersion 必须为 ${SCHEMA_VERSION}`);
  }
  return errors;
}

// --- 心跳响应（两端共用，只是寻址字段不同名） ---
export function validateLeaseReply(reply, module) {
  const errors = [];
  if (!reply || typeof reply !== 'object') return ['lease: 不是对象'];
  const addrField = module === 'experiment' ? 'requestedDevices' : 'requestedPacks';
  checkRequired(reply, ['subscriptionId', 'leaseSeconds', addrField], 'lease', errors);

  if (typeof reply.subscriptionId !== 'string') errors.push('lease: subscriptionId 必须是字符串');
  if (!inRange(reply.leaseSeconds, LEASE.leaseSecondsMin, LEASE.leaseSecondsMax))
    errors.push(`lease: leaseSeconds 必须 ${LEASE.leaseSecondsMin}..${LEASE.leaseSecondsMax}`);
  if (reply.leaseSeconds > 0 && !reply.subscriptionId)
    errors.push('lease: leaseSeconds>0 时 subscriptionId 不得为空');
  if (!Array.isArray(reply[addrField])) {
    errors.push(`lease: ${addrField} 必须是数组`);
  } else {
    const a = reply[addrField];
    if (a.length > LEASE.requestedPacksMaxItems) errors.push(`lease: ${addrField} 不得超过 ${LEASE.requestedPacksMaxItems} 项`);
    if (new Set(a).size !== a.length) errors.push(`lease: ${addrField} 不得重复`);
    if (module === 'experiment') {
      for (const d of a) {
        if (typeof d !== 'string' || d.length === 0 || d.length > LEASE.requestedDeviceIdMaxLen)
          errors.push(`lease: requestedDevices 每项必须是非空字符串且 ≤${LEASE.requestedDeviceIdMaxLen}`);
      }
    } else {
      for (const p of a) {
        if (!isInt(p) || !inRange(p, LEASE.requestedPackMin, LEASE.requestedPackMax))
          errors.push(`lease: requestedPacks 每项必须是 ${LEASE.requestedPackMin}..${LEASE.requestedPackMax} 的整数`);
      }
    }
  }
  if (reply.backfillSeconds !== undefined && !inRange(reply.backfillSeconds, LEASE.backfillSecondsMin, LEASE.backfillSecondsMax))
    errors.push(`lease: backfillSeconds 必须 ${LEASE.backfillSecondsMin}..${LEASE.backfillSecondsMax}`);

  if (reply.requestedHistoryPoints !== undefined) {
    const hp = reply.requestedHistoryPoints;
    if (!Array.isArray(hp)) {
      errors.push('lease: requestedHistoryPoints 必须是数组');
    } else {
      if (hp.length > LEASE.requestedHistoryPointsMaxItems)
        errors.push(`lease: requestedHistoryPoints 不得超过 ${LEASE.requestedHistoryPointsMaxItems} 项`);
      for (const s of hp) {
        if (typeof s !== 'string' || s.length > LEASE.requestedHistoryPointMaxLen)
          errors.push(`lease: requestedHistoryPoints 每项 ≤${LEASE.requestedHistoryPointMaxLen} 字符`);
        else if (s.split('/').length !== 2)
          errors.push(`lease: requestedHistoryPoints 每项必须恰好一个 '/'，得到 "${s}"`);
        else if (Array.isArray(reply[addrField]) && !reply[addrField].includes(s.split('/')[0]))
          errors.push(`lease: requestedHistoryPoints 前缀 "${s.split('/')[0]}" 必须在 ${addrField} 内`);
      }
    }
  }
  return errors;
}

// --- BMS 快照 ---
export function validateBmsSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object') return ['bms.snapshot: 不是对象'];
  const allowed = [...BMS_SNAPSHOT.required, ...BMS_SNAPSHOT.optional];
  checkRequired(snapshot, BMS_SNAPSHOT.required, 'bms.snapshot', errors);
  checkNoUnknown(snapshot, allowed, 'bms.snapshot', errors);

  const L = BMS_SNAPSHOT.limits;
  if (snapshot.schemaVersion !== SCHEMA_VERSION) errors.push(`bms.snapshot: schemaVersion 必须为 ${SCHEMA_VERSION}`);
  if (!isInt(snapshot.address) || !inRange(snapshot.address, L.addressMin, L.addressMax))
    errors.push(`bms.snapshot: address 必须 ${L.addressMin}..${L.addressMax}`);
  if (!isInt(snapshot.pack) || !inRange(snapshot.pack, L.packMin, L.packMax))
    errors.push(`bms.snapshot: pack 必须 ${L.packMin}..${L.packMax}`);
  for (const f of ['voltageCentivolts', 'socPercent', 'sohPercent', 'remainingCentiAh', 'totalCentiAh', 'cycles', 'humidityPercent'])
    if (!isInt(snapshot[f]) || snapshot[f] < 0) errors.push(`bms.snapshot: ${f} 必须是非负整数（单位见 BMS_UNITS）`);
  if (!isInt(snapshot.currentCentiamps)) errors.push('bms.snapshot: currentCentiamps 必须是整数（可为负）');
  if (!isInt(snapshot.sequence) || snapshot.sequence < 1) errors.push('bms.snapshot: sequence 必须 ≥1 的整数');
  if (!isUtcIso(snapshot.capturedUtc)) errors.push('bms.snapshot: capturedUtc 必须是 UTC ISO-8601（以 Z 结尾）');
  checkEnum(snapshot.source, ['serial', 'simulation'], 'bms.snapshot.source', errors);
  if (snapshot.periodSeconds !== undefined && !inRange(snapshot.periodSeconds, L.periodSecondsMin, L.periodSecondsMax))
    errors.push(`bms.snapshot: periodSeconds 必须 ${L.periodSecondsMin}..${L.periodSecondsMax}`);
  if (!Array.isArray(snapshot.cellsMillivolts) || snapshot.cellsMillivolts.length > L.cellsMax)
    errors.push(`bms.snapshot: cellsMillivolts 必须是数组且 ≤${L.cellsMax}`);
  if (!Array.isArray(snapshot.temperaturesCelsius) || snapshot.temperaturesCelsius.length > L.temperaturesMax)
    errors.push(`bms.snapshot: temperaturesCelsius 必须是数组且 ≤${L.temperaturesMax}`);
  if (typeof snapshot.alarmObservationAvailable !== 'boolean')
    errors.push('bms.snapshot: alarmObservationAvailable 必须是布尔');
  if (snapshot.alarmObservationAvailable === false && snapshot.alarmObservation)
    errors.push('bms.snapshot: alarmObservationAvailable=false 时不得携带 alarmObservation');
  if (snapshot.alarmObservation) {
    const a = snapshot.alarmObservation;
    checkRequired(a, BMS_SNAPSHOT.alarm.required, 'bms.snapshot.alarmObservation', errors);
    if (!isUtcIso(a.observedUtc)) errors.push('bms.snapshot.alarmObservation: observedUtc 必须是 UTC ISO-8601');
    if (typeof a.payloadHex !== 'string' || !/^[0-9A-Fa-f]+$/.test(a.payloadHex) || a.payloadHex.length > BMS_SNAPSHOT.alarm.payloadHexMaxLen)
      errors.push('bms.snapshot.alarmObservation: payloadHex 必须是 ≤4096 字符的十六进制');
  }
  return errors;
}

// --- 实验快照 ---
export function validateExperimentSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object') return ['experiment.snapshot: 不是对象'];
  const E = EXPERIMENT_SNAPSHOT;
  const allowed = [...E.required, ...(E.optional ?? [])];
  checkRequired(snapshot, E.required, 'experiment.snapshot', errors);
  checkNoUnknown(snapshot, allowed, 'experiment.snapshot', errors);

  if (snapshot.schemaVersion !== SCHEMA_VERSION) errors.push(`experiment.snapshot: schemaVersion 必须为 ${SCHEMA_VERSION}`);
  if (snapshot.module !== 'experiment') errors.push('experiment.snapshot: module 必须是 "experiment"');
  if (!isUtcIso(snapshot.capturedUtc)) errors.push('experiment.snapshot: capturedUtc 必须是 UTC ISO-8601');
  checkEnum(snapshot.source, ['serial', 'simulation'], 'experiment.snapshot.source', errors);
  if (!isInt(snapshot.sequence) || snapshot.sequence < 1) errors.push('experiment.snapshot: sequence 必须 ≥1');
  if (!isInt(snapshot.slave)) errors.push('experiment.snapshot: slave 必须是整数');
  if (!Array.isArray(snapshot.points)) return errors.concat(['experiment.snapshot: points 必须是数组']);
  if (snapshot.points.length > E.maxPointsPerSnapshot)
    errors.push(`experiment.snapshot: 单快照点数不得超过 ${E.maxPointsPerSnapshot}`);

  snapshot.points.forEach((p, i) => {
    const w = `experiment.snapshot.points[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${w}: 不是对象`); return; }
    checkRequired(p, E.point.required, w, errors);
    checkNoUnknown(p, [...E.point.required, ...E.point.optional], w, errors);
    checkEnum(p.quality, [...QUALITY.local, ...QUALITY.wireOnly], `${w}.quality`, errors);
    if (QUALITY.mustBeNull.includes(p.quality) && p.value !== null)
      errors.push(`${w}: quality="${p.quality}" 时 value 必须为 null（真实零值不等于失败，反之亦然）`);
    if (p.value !== null && p.value !== undefined && typeof p.value !== 'number')
      errors.push(`${w}: value 必须是 number 或 null`);
    if (p.displayValue !== null && typeof p.displayValue !== 'string')
      errors.push(`${w}: displayValue 必须是 string 或 null`);
    if (!isUtcIso(p.observedUtc)) errors.push(`${w}: observedUtc 必须是 UTC ISO-8601`);
    if (p.description !== undefined && String(p.description).length > E.point.limits.descriptionMaxLen)
      errors.push(`${w}: description ≤${E.point.limits.descriptionMaxLen}`);
    if (p.unit !== undefined && String(p.unit).length > E.point.limits.unitMaxLen)
      errors.push(`${w}: unit ≤${E.point.limits.unitMaxLen}`);
  });
  return errors;
}

// --- 快照外壳 ---
export function validateSnapshotEnvelope(body, module) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['snapshots: 不是对象'];
  checkRequired(body, ['subscriptionId', 'snapshot'], 'snapshots', errors);
  checkNoUnknown(body, ['subscriptionId', 'snapshot'], 'snapshots', errors);
  if (typeof body.subscriptionId !== 'string') errors.push('snapshots: subscriptionId 必须是字符串');
  errors.push(...(module === 'experiment'
    ? validateExperimentSnapshot(body.snapshot)
    : validateBmsSnapshot(body.snapshot)));
  return errors;
}

// --- 点表一致性 ---
export function validateCatalogPair(cloudCatalog, deviceCatalog) {
  const errors = [];
  if (cloudCatalog.schemaVersion !== SCHEMA_VERSION) errors.push('catalog: 云端 schemaVersion 不是 1');
  if (deviceCatalog.schemaVersion !== SCHEMA_VERSION) errors.push('catalog: 设备端 schemaVersion 不是 1');
  if (cloudCatalog.catalogVersion !== deviceCatalog.catalogVersion)
    errors.push(`catalog: 版本不一致 —— 云端 ${cloudCatalog.catalogVersion} vs 设备端 ${deviceCatalog.catalogVersion}`);

  const key = (p) => `${p.equipmentId}/${p.id}`;
  const c = new Map(cloudCatalog.points.map((p) => [key(p), p]));
  const d = new Map(deviceCatalog.points.map((p) => [key(p), p]));

  for (const k of c.keys()) if (!d.has(k)) errors.push(`catalog: 设备端缺测点 ${k}`);
  for (const k of d.keys()) if (!c.has(k)) errors.push(`catalog: 云端多测点 ${k}`);

  const metaDiffs = [];
  for (const [k, cp] of c) {
    const dp = d.get(k);
    if (!dp) continue;
    for (const f of ['slave', 'addressZeroBased', 'registerCount']) {
      if (cp[f] !== dp[f]) errors.push(`catalog: ${k} 绑定三元组 ${f} 分叉（云端 ${cp[f]} / 设备 ${dp[f]}）—— 这是致命错误`);
    }
    for (const f of ['Name', 'Label', 'Group', 'Unit', 'Mode', 'Scale']) {
      if (cp.metadata?.[f] !== dp.metadata?.[f]) metaDiffs.push(`${k}.${f}: "${cp.metadata?.[f]}" vs "${dp.metadata?.[f]}"`);
    }
  }
  return { errors, metaDiffs };
}
