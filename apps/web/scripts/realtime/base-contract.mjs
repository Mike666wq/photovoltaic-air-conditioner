// @generated 由 _base/contract/contract.mjs 生成，请勿手改。
// @source-sha256 0fe84be83ac58117719f51913bfcd4cb000e3846ecabf7a9318b05a6211c9aca
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

// ---------- 设备接入（模块无关） ----------
// 单独一个前缀，和上面三个业务前缀彻底分开：认领发生在「还没有设备令牌」的时刻，
// 而业务前缀的每个端点都要求 Bearer 令牌 —— 混在一起就只能靠 401 猜，那是错的。
// 不要把本前缀加进 PREFIX_MODULE：它不属于任何 module，模块信息在请求体里。
export const DEVICE_PREFIX = '/api/device';

export const DEVICE_ROUTES = {
  claim:       () => `${DEVICE_PREFIX}/claim`,
  claimStatus: (claimId) => `${DEVICE_PREFIX}/claim/${claimId}`,
  ack:         () => `${DEVICE_PREFIX}/ack`,
  // 管理端点（浏览器会话 + CSRF，不认设备令牌）
  adminClaims:     () => `${DEVICE_PREFIX}/admin/claims`,
  adminApprove:    (claimId) => `${DEVICE_PREFIX}/admin/claims/${claimId}/approve`,
  adminReject:     (claimId) => `${DEVICE_PREFIX}/admin/claims/${claimId}/reject`,
  adminDevices:    () => `${DEVICE_PREFIX}/admin/devices`,
  adminDevice:     (deviceId) => `${DEVICE_PREFIX}/admin/devices/${deviceId}`,
  adminSuspend:    (deviceId) => `${DEVICE_PREFIX}/admin/devices/${deviceId}/suspend`,
  adminResume:     (deviceId) => `${DEVICE_PREFIX}/admin/devices/${deviceId}/resume`,
  adminRekey:      (deviceId) => `${DEVICE_PREFIX}/admin/devices/${deviceId}/rekey`,
};

// 设备状态机。pending/approved 不占设备限额；revoked 是墓碑（保留后清除）。
// 禁止的迁移见 SPEC §16：pending→active、revoked→active、suspended→approved 一律 409。
export const DEVICE_STATE = {
  pending: 'pending',
  approved: 'approved',
  active: 'active',
  suspended: 'suspended',
  revoked: 'revoked',
  rejected: 'rejected',
  expired: 'expired',
  conflict: 'conflict',
  all: ['pending', 'approved', 'active', 'suspended', 'revoked', 'rejected', 'expired', 'conflict'],
  // 只有这两个占用 maxDevices 配额
  billable: ['active', 'suspended'],
  // 这些状态仍然可以接受心跳（用来下发指令），但不得上传数据
  reachable: ['active', 'suspended', 'revoked'],
};

export const ENROLLMENT = {
  protocolVersion: 2,        // 下行协议版本；缺省 = 1（老客户端）
  machineKeyPrefix: 'mk_',
  machineKeyHexLen: 32,      // 16 字节 -> 32 hex
  secretLenMin: 32,          // claimSecret / deviceToken 的 Bearer 长度下界
  secretLenMax: 256,
  claimTtlSeconds: 1800,     // 认领有效期（RFC 8628 的 expires_in 示例值）
  pollIntervalSec: 5,        // 轮询间隔（RFC 8628 缺省）
  pollSlowDownSec: 5,        // 限流时回包用，客户端按此加长间隔
  ackDeadlineSec: 300,       // 批准→ack 的截止（超时作废未交付令牌）
  grantTtlSeconds: 3600,     // 明文令牌的一次性交付窗口
  tombstoneHours: 24,        // revoked 墓碑保留时长
  maxPending: 5,             // 待批准上限（不占 maxDevices）
  maxTombstones: 20,         // 墓碑上限
  claimRatePerMinute: 10,    // 全局认领限流
  claimRatePerKeyPerMinute: 5,
  maxBodyBytes: 4096,        // 认领/确认请求体上限
};

// 管理员可以下发的设备配置白名单。
// 红线：这里绝不能出现采样周期、串口号、波特率、Modbus 站号 —— 采集参数归本地。
// allowedAddresses 是「允许上传的帧地址范围」，不是「本地去轮询哪些地址」。
export const DEVICE_CONFIG = {
  fields: [
    'deviceId', 'alias', 'module',
    'allowedAddresses', 'allowedPacks', 'allowedEquipment',
    'allowSimulation', 'displayTimeZone',
    'uploadEnabled', 'heartbeatIntervalSec',
    'statusReason', 'changedBy', 'changedAtUtc', 'note',
  ],
  // 明确禁止：任何采集侧参数。出现即视为协议违规。
  forbidden: [
    'periodSeconds', 'sampleIntervalMs', 'pollIntervalMs',
    'portName', 'comPort', 'baudRate', 'parity', 'dataBits', 'stopBits',
    'slave', 'stationId', 'unitId',
  ],
};

// 设备命令类型。
export const DEVICE_COMMAND = {
  types: ['stop-upload', 'resume-upload', 'reclaim', 'rotate-token', 'wipe-credentials'],
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

// ---------- 心跳与设备自述 ----------
// 心跳是设备唯一「还能说话」的通道：离线诊断需要的现场信息全部搭车在这一条请求上。
//
// 铁律（任一破坏都会让所有设备一起变离线）：
//   · 自述字段全部可选；解析失败/超限/类型不对 → 整块降级为 null，心跳本身必须照常成功。
//   · 未知字段一律忽略。
//   · 自述是「客户端对自己状态的声明」，不是可信断言；服务端只存不算账。
export const HEARTBEAT = {
  intervalSeconds: 15,        // 无租约时的默认心跳周期（回包会带回同值，两端不各写一份）
  // 客户端心跳下限。历史上 BMS 是 2000ms、实验端是 250ms，而服务端 60 秒窗口只给 30 次——
  // 实验端那个下限等于 240 次/分钟，一进入临界租约就是必炸的 429 风暴。下限与上限必须对得上。
  minIntervalMs: 3000,
  // 服务端单设备心跳上限。心跳不写注册表、不占缓存，成本只有一次 JSON 解析，
  // 所以给足余量（3 秒一次 = 20/分钟，留 6 倍余量给重试与诊断），而不是卡着客户端打满。
  ratePerMinute: 120,
  offlineAfterMisses: 3,      // 连续漏检达到该值才翻「离线」（防抖：单次丢包不算掉线）
  clientMaxBytes: 4096,       // 自述块序列化上限，超出即整体降级
  maxConsecutiveFailures: 9999,
  retrySecMax: 3600,
  uptimeSecMax: 31536000,     // 1 年
  tzOffsetMinMax: 1440,
  countMax: 9999,
  versionMaxLen: 32,
  codeMaxLen: 64,
  messageMaxLen: 200,
  timelineMaxEntries: 200,    // 每设备事件环形缓冲
  // 失败阶段枚举。客户端把自己失败在哪一段如实上报，服务端据此翻译成人话。
  stageEnum: ['DNS', 'PROXY', 'TCP', 'TLS', 'AUTH', 'HTTP', 'PROTOCOL', 'SERIAL'],
  // 设备事件类型（环形缓冲里只出现这些）
  eventEnum: [
    'first-seen', 'heartbeat', 'online', 'offline', 'client-error',
    'upload-rejected', 'lease-expired', 'diag-report', 'identity-mismatch',
  ],
};

// 设备自述块（heartbeat.client）。字段缺省 = 未知，绝不等于「正常」。
export const CLIENT_REPORT = {
  optional: [
    'version', 'startedUtc', 'uptimeSec', 'localTimeUtc', 'tzOffsetMin',
    'cloudEnabled', 'tokenDecryptable', 'lastSuccessUtc', 'consecutiveFailures',
    'nextRetryInSec', 'lastError', 'lastUpload', 'source',
  ],
  lastError: {
    required: ['stage'],
    optional: ['code', 'httpStatus', 'atUtc', 'message', 'count'],
  },
  lastUpload: { optional: ['attemptUtc', 'acceptedUtc', 'lastError'] },
};

const _isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v);
const _isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const _clampInt = (v, min, max) => {
  const n = Math.trunc(v);
  return n < min ? min : n > max ? max : n;
};
const _str = (v, maxLen) => (typeof v === 'string' && v.length > 0 && v.length <= maxLen ? v : undefined);
const _pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
};

function _sanitizeError(e, L) {
  if (!e || typeof e !== 'object') return undefined;
  if (!L.stageEnum.includes(e.stage)) return undefined; // 未知阶段不猜，直接丢弃
  const out = { stage: e.stage };
  const code = _str(e.code, L.codeMaxLen); if (code !== undefined) out.code = code;
  if (_isInt(e.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599) out.httpStatus = e.httpStatus;
  if (_isIso(e.atUtc)) out.atUtc = e.atUtc;
  const message = _str(e.message, L.messageMaxLen); if (message !== undefined) out.message = message;
  if (_isInt(e.count)) out.count = _clampInt(e.count, 0, L.countMax);
  return out;
}

/**
 * 心跳自述清洗：永不抛错，坏数据一律降级为 undefined/null。
 * 直接返回给 state.heartbeat 存起来即可——服务端不做判断，只做保存与翻译。
 */
export function sanitizeClientReport(input) {
  const L = HEARTBEAT;
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  let encoded;
  try { encoded = JSON.stringify(input); } catch { return null; } // 循环引用等
  if (typeof encoded !== 'string' || encoded.length > L.clientMaxBytes) return null;

  const out = {};
  const version = _str(input.version, L.versionMaxLen); if (version !== undefined) out.version = version;
  if (input.startedUtc !== undefined && _isIso(input.startedUtc)) out.startedUtc = input.startedUtc;
  if (input.localTimeUtc !== undefined && _isIso(input.localTimeUtc)) out.localTimeUtc = input.localTimeUtc;
  if (input.lastSuccessUtc !== undefined && _isIso(input.lastSuccessUtc)) out.lastSuccessUtc = input.lastSuccessUtc;
  if (_isInt(input.uptimeSec)) out.uptimeSec = _clampInt(input.uptimeSec, 0, L.uptimeSecMax);
  if (_isInt(input.tzOffsetMin)) out.tzOffsetMin = _clampInt(input.tzOffsetMin, -L.tzOffsetMinMax, L.tzOffsetMinMax);
  if (typeof input.cloudEnabled === 'boolean') out.cloudEnabled = input.cloudEnabled;
  if (typeof input.tokenDecryptable === 'boolean') out.tokenDecryptable = input.tokenDecryptable;
  if (_isInt(input.consecutiveFailures)) out.consecutiveFailures = _clampInt(input.consecutiveFailures, 0, L.maxConsecutiveFailures);
  if (_isInt(input.nextRetryInSec)) out.nextRetryInSec = _clampInt(input.nextRetryInSec, 0, L.retrySecMax);

  const err = _sanitizeError(input.lastError, L); if (err) out.lastError = err;
  if (input.lastUpload && typeof input.lastUpload === 'object') {
    const up = {};
    if (_isIso(input.lastUpload.attemptUtc)) up.attemptUtc = input.lastUpload.attemptUtc;
    if (_isIso(input.lastUpload.acceptedUtc)) up.acceptedUtc = input.lastUpload.acceptedUtc;
    const upErr = _sanitizeError(input.lastUpload.lastError, L); if (upErr) up.lastError = upErr;
    if (Object.keys(up).length) out.lastUpload = up;
  }
  if (input.source && typeof input.source === 'object') {
    const src = input.source;
    const s = {};
    if (typeof src.session === 'string' && src.session.length <= 128) s.session = src.session;
    // 采集侧：串口是否打开、最后一帧时间。只保留结构化事实，不收自由文本。
    const chan = src.serial ?? src.modbus;
    if (chan && typeof chan === 'object') {
      const c = {};
      const port = _str(chan.port, 32); if (port !== undefined) c.port = port;
      if (typeof chan.open === 'boolean') c.open = chan.open;
      if (_isIso(chan.lastFrameUtc)) c.lastFrameUtc = chan.lastFrameUtc;
      if (Object.keys(c).length) s[src.serial ? 'serial' : 'modbus'] = c;
    }
    if (Object.keys(s).length) out.source = s;
  }
  return Object.keys(out).length ? out : null;
}

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
  // 设备配置下行：以下全部可选，缺失即「老客户端」。绝不因此拒绝心跳。
  // protocolVersion 单独一个整数，不复用 schemaVersion（实验端对后者有 ===1 的硬断言）。
  if (body.protocolVersion !== undefined && (!isInt(body.protocolVersion) || body.protocolVersion < 1 || body.protocolVersion > 99))
    errors.push('heartbeat: protocolVersion 必须是 1..99 的整数');
  if (body.machineKey !== undefined && !isMachineKey(body.machineKey))
    errors.push(`heartbeat: machineKey 必须形如 ${ENROLLMENT.machineKeyPrefix}<${ENROLLMENT.machineKeyHexLen} 位小写 hex>`);
  if (body.reportedConfigVersion !== undefined && (!isInt(body.reportedConfigVersion) || body.reportedConfigVersion < 0))
    errors.push('heartbeat: reportedConfigVersion 必须是非负整数');
  if (body.reportedCommandId !== undefined && (typeof body.reportedCommandId !== 'string' || body.reportedCommandId.length > 128))
    errors.push('heartbeat: reportedCommandId 必须是 ≤128 字符的字符串');
  return errors;
}

export const isMachineKey = (v) =>
  typeof v === 'string'
  && v.length === ENROLLMENT.machineKeyPrefix.length + ENROLLMENT.machineKeyHexLen
  && v.startsWith(ENROLLMENT.machineKeyPrefix)
  && /^[0-9a-f]+$/.test(v.slice(ENROLLMENT.machineKeyPrefix.length));

/** 认领请求：无设备令牌，靠 claimSecret 证明「我是发起这次认领的那台机器」。 */
export function validateClaimRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['claim: 不是对象'];
  checkRequired(body, ['machineKey', 'module'], 'claim', errors);
  if (!isMachineKey(body.machineKey))
    errors.push(`claim: machineKey 必须形如 ${ENROLLMENT.machineKeyPrefix}<${ENROLLMENT.machineKeyHexLen} 位小写 hex>`);
  checkEnum(body.module, MODULES, 'claim.module', errors);
  if (body.protocolVersion !== undefined && (!isInt(body.protocolVersion) || body.protocolVersion < 1 || body.protocolVersion > 99))
    errors.push('claim: protocolVersion 必须是 1..99 的整数');
  if (body.desiredAlias !== undefined && (typeof body.desiredAlias !== 'string' || body.desiredAlias.length > 128))
    errors.push('claim: desiredAlias 必须是 ≤128 字符的字符串（仅作管理员参考，不作为最终别名）');
  return errors;
}

/**
 * 设备配置白名单校验 —— 只用于「云端下发给客户端」的那份 config。
 * 出现采集参数（串口/波特率/站号/采样周期）一律判违规：那是本地的东西，云端不许碰。
 */
export function validateDeviceConfigPayload(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['deviceConfig: 不是对象'];
  for (const field of DEVICE_CONFIG.forbidden)
    if (Object.hasOwn(config, field)) errors.push(`deviceConfig: 不得下发采集参数 ${field}（采集配置归本地）`);
  if (config.deviceId !== undefined && (typeof config.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(config.deviceId)))
    errors.push('deviceConfig: deviceId 必须匹配 ^[A-Za-z0-9_-]{1,80}$');
  if (config.alias !== undefined && (typeof config.alias !== 'string' || config.alias.length > 128))
    errors.push('deviceConfig: alias 必须是 ≤128 字符的字符串');
  if (config.module !== undefined) checkEnum(config.module, MODULES, 'deviceConfig.module', errors);
  if (config.allowedPacks !== undefined && (!Array.isArray(config.allowedPacks)
      || config.allowedPacks.length > LEASE.requestedPacksMaxItems
      || !config.allowedPacks.every((p) => isInt(p) && inRange(p, LEASE.requestedPackMin, LEASE.requestedPackMax))))
    errors.push(`deviceConfig: allowedPacks 必须是 1..${LEASE.requestedPacksMaxItems} 项的 ${LEASE.requestedPackMin}..${LEASE.requestedPackMax} 整数数组`);
  if (config.allowedAddresses !== undefined && (!Array.isArray(config.allowedAddresses)
      || config.allowedAddresses.length > 16
      || !config.allowedAddresses.every((a) => isInt(a) && a >= 1 && a <= 255)))
    errors.push('deviceConfig: allowedAddresses 必须是 ≤16 项的 1..255 整数数组');
  if (config.allowSimulation !== undefined && typeof config.allowSimulation !== 'boolean')
    errors.push('deviceConfig: allowSimulation 必须是布尔');
  if (config.uploadEnabled !== undefined && typeof config.uploadEnabled !== 'boolean')
    errors.push('deviceConfig: uploadEnabled 必须是布尔');
  if (config.heartbeatIntervalSec !== undefined && (!isInt(config.heartbeatIntervalSec) || config.heartbeatIntervalSec < 3 || config.heartbeatIntervalSec > 3600))
    errors.push('deviceConfig: heartbeatIntervalSec 必须是 3..3600 的整数');
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
