import { createHash, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './contract.mjs';
import { EQUIPMENT } from './experiment-contract.mjs';

const scrypt = promisify(derive);
export const opaque = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export function equal(a, b) {
  const x = Buffer.from(a ?? ''); const y = Buffer.from(b ?? '');
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const result = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${result.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [, salt, expected] = hash.split('$');
  const result = await scrypt(password, salt, 64);
  return equal(result.toString('hex'), expected);
}
function setting(env, key, fallback, max) {
  if (env[key] == null) return fallback;
  const n = Number(env[key]); assert(Number.isInteger(n) && n >= 1 && n <= max, 503, 'CONFIG_INVALID', `配置${key}无效`); return n;
}
export function loadConfig(env = process.env) {
  const enabled = env.BMS_REALTIME_ENABLED === '1';
  if (!enabled) return { enabled: false };
  const registryDir = env.BMS_REALTIME_REGISTRY_DIR ? resolve(env.BMS_REALTIME_REGISTRY_DIR) : undefined;
  if (registryDir) {
    const publicDirectories = [fileURLToPath(new URL('../../dist', import.meta.url)), env.SCENARIOS_DIR ? resolve(env.SCENARIOS_DIR) : fileURLToPath(new URL('../../../../scenarios', import.meta.url))];
    assert(publicDirectories.every((dir) => registryDir !== dir && !registryDir.startsWith(dir + sep)), 503, 'CONFIG_INVALID', '注册存储必须独立于公开静态目录及场景目录');
  }
  let devices = [], users = [], system;
  if (registryDir && existsSync(join(registryDir, 'registry.json'))) {
    const data = JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8'));
    assert([1, 2].includes(data.version), 503, 'CONFIG_INVALID', '注册存储版本无效');
    ({ devices, users } = data); system = data.system;
  } else if (env.BMS_DEVICES_FILE && env.BMS_VIEWER_CREDENTIALS_FILE) {
    devices = JSON.parse(readFileSync(env.BMS_DEVICES_FILE, 'utf8')).devices;
    users = JSON.parse(readFileSync(env.BMS_VIEWER_CREDENTIALS_FILE, 'utf8')).users;
  } else assert(registryDir, 503, 'CONFIG_INVALID', '需要注册存储目录或现有注册文件');
  let bootstrapHash;
  if (env.BMS_REALTIME_BOOTSTRAP_TOKEN_FILE) {
    const token = readFileSync(env.BMS_REALTIME_BOOTSTRAP_TOKEN_FILE, 'utf8').trim();
    assert(/^[a-zA-Z0-9_-]{32,256}$/.test(token), 503, 'CONFIG_INVALID', '初始化密钥无效');
    bootstrapHash = tokenHash(token);
  }
  const publicOrigin = env.BMS_REALTIME_PUBLIC_ORIGIN;
  const devHttp = env.BMS_REALTIME_DEV_HTTP === '1' && env.NODE_ENV !== 'production';
  const url = new URL(publicOrigin);
  assert(url.origin === publicOrigin && (url.protocol === 'https:' || (devHttp && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))), 503, 'CONFIG_INVALID', '必须配置HTTPS网站根Origin');
  return {
    enabled, devices, users, system: system ?? { name: '实验系统', experimentDeviceId: null, bmsDeviceId: null, allowSimulation: false }, publicOrigin, devHttp, registryDir, bootstrapHash,
    cacheMs: 3600000,
    maxPoints: setting(env, 'BMS_REALTIME_MAX_POINTS', 600, 600),
    viewerMs: setting(env, 'BMS_REALTIME_VIEWER_TTL_SECONDS', 45, 45) * 1000,
    maxDevices: setting(env, 'BMS_REALTIME_MAX_DEVICES', 20, 100),
    maxViewers: setting(env, 'BMS_REALTIME_MAX_VIEWERS_PER_USER', 4, 4),
    maxActiveUsers: 10,
    maxViewerLeases: 40,
    maxSsePerUser: 8,
    browserRequestsPerMinute: setting(env, 'BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE', 5000, 10000),
    maxCachePoints: setting(env, 'BMS_REALTIME_MAX_CACHE_POINTS', 500000, 5000000),
    maxCacheBytes: setting(env, 'BMS_REALTIME_MAX_CACHE_BYTES', 134217728, 1073741824),
  };
}
export function validateConfig(config) {
  assert(Array.isArray(config.devices) && config.devices.length <= (config.maxDevices ?? 20), 503, 'CONFIG_INVALID');
  const ids = new Set(); const tokens = new Set();
  for (const d of config.devices) {
    assert(/^[a-zA-Z0-9_-]{1,80}$/.test(d.deviceId) && !ids.has(d.deviceId), 503, 'CONFIG_INVALID'); ids.add(d.deviceId);
    assert(typeof d.alias === 'string' && d.alias.length <= 128 && /^[0-9a-f]{64}$/.test(d.deviceTokenHash) && !tokens.has(d.deviceTokenHash), 503, 'CONFIG_INVALID'); tokens.add(d.deviceTokenHash);
    d.module ??= 'bms'; assert(['bms','experiment'].includes(d.module),503,'CONFIG_INVALID');
    if(d.module==='experiment') {
      assert(Array.isArray(d.allowedEquipment) && d.allowedEquipment.length>0 && d.allowedEquipment.length<=4 && d.allowedEquipment.every(id=>EQUIPMENT.includes(id)),503,'CONFIG_INVALID');
    } else {
    assert(Array.isArray(d.allowedPacks) && d.allowedPacks.length > 0 && d.allowedPacks.length <= 16 && d.allowedPacks.every((p) => Number.isInteger(p) && p >= 1 && p <= 16), 503, 'CONFIG_INVALID');
    d.allowedAddresses ??= [1];
    assert(Array.isArray(d.allowedAddresses) && d.allowedAddresses.length > 0 && d.allowedAddresses.length <= 16 && d.allowedAddresses.every((a) => Number.isInteger(a) && a >= 1 && a <= 255), 503, 'CONFIG_INVALID');
    }
    assert(typeof d.allowSimulation === 'boolean' && (d.displayTimeZone == null || d.displayTimeZone === 'Asia/Shanghai'), 503, 'CONFIG_INVALID');
  }
  assert(Array.isArray(config.users) && config.users.length <= 100 && (config.users.length > 0 || (config.registryDir && config.devices.length === 0)), 503, 'CONFIG_INVALID');
  const names = new Set();
  for (const u of config.users) {
    assert(typeof u.username === 'string' && u.username.length > 0 && u.username.length <= 80 && !names.has(u.username), 503, 'CONFIG_INVALID'); names.add(u.username);
    assert(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(u.passwordHash), 503, 'CONFIG_INVALID');
    assert(Array.isArray(u.devices) && u.devices.every((id) => ids.has(id)) && ['viewer', 'admin'].includes(u.role ?? 'viewer'), 503, 'CONFIG_INVALID');
    u.monitoringAccess ??= false; u.disabled ??= false;
    assert(typeof u.monitoringAccess === 'boolean' && typeof u.disabled === 'boolean', 503, 'CONFIG_INVALID');
  }
  config.system ??= { name: '实验系统', experimentDeviceId: null, bmsDeviceId: null, allowSimulation: false };
  const system = config.system;
  assert(typeof system.name === 'string' && system.name.trim().length > 0 && system.name.length <= 128 && typeof system.allowSimulation === 'boolean', 503, 'CONFIG_INVALID');
  for (const [field, module] of [['experimentDeviceId', 'experiment'], ['bmsDeviceId', 'bms']]) {
    const id = system[field];
    assert(id == null || (typeof id === 'string' && config.devices.some((d) => d.deviceId === id && (d.module ?? 'bms') === module)), 503, 'CONFIG_INVALID');
  }
}
