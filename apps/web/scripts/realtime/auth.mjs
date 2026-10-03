import { createHash, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { assert } from './contract.mjs';

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
  const devices = JSON.parse(readFileSync(env.BMS_DEVICES_FILE, 'utf8')).devices;
  const users = JSON.parse(readFileSync(env.BMS_VIEWER_CREDENTIALS_FILE, 'utf8')).users;
  const publicOrigin = env.BMS_REALTIME_PUBLIC_ORIGIN;
  const devHttp = env.BMS_REALTIME_DEV_HTTP === '1' && env.NODE_ENV !== 'production';
  const url = new URL(publicOrigin);
  assert(url.origin === publicOrigin && (url.protocol === 'https:' || (devHttp && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))), 503, 'CONFIG_INVALID', '必须配置HTTPS网站根Origin');
  return {
    enabled, devices, users, publicOrigin, devHttp,
    cacheMs: setting(env, 'BMS_REALTIME_CACHE_TTL_SECONDS', 600, 600) * 1000,
    maxPoints: setting(env, 'BMS_REALTIME_MAX_POINTS', 600, 600),
    viewerMs: setting(env, 'BMS_REALTIME_VIEWER_TTL_SECONDS', 45, 45) * 1000,
    maxDevices: setting(env, 'BMS_REALTIME_MAX_DEVICES', 20, 100),
    maxViewers: setting(env, 'BMS_REALTIME_MAX_VIEWERS_PER_USER', 4, 4),
  };
}
export function validateConfig(config) {
  assert(Array.isArray(config.devices) && config.devices.length <= (config.maxDevices ?? 20), 503, 'CONFIG_INVALID');
  const ids = new Set(); const tokens = new Set();
  for (const d of config.devices) {
    assert(/^[a-zA-Z0-9_-]{1,80}$/.test(d.deviceId) && !ids.has(d.deviceId), 503, 'CONFIG_INVALID'); ids.add(d.deviceId);
    assert(typeof d.alias === 'string' && d.alias.length <= 128 && /^[0-9a-f]{64}$/.test(d.deviceTokenHash) && !tokens.has(d.deviceTokenHash), 503, 'CONFIG_INVALID'); tokens.add(d.deviceTokenHash);
    assert(Array.isArray(d.allowedPacks) && d.allowedPacks.length > 0 && d.allowedPacks.length <= 16 && d.allowedPacks.every((p) => Number.isInteger(p) && p >= 1 && p <= 16), 503, 'CONFIG_INVALID');
    d.allowedAddresses ??= [1];
    assert(Array.isArray(d.allowedAddresses) && d.allowedAddresses.length > 0 && d.allowedAddresses.length <= 16 && d.allowedAddresses.every((a) => Number.isInteger(a) && a >= 1 && a <= 255), 503, 'CONFIG_INVALID');
    assert(typeof d.allowSimulation === 'boolean' && (d.displayTimeZone == null || d.displayTimeZone === 'Asia/Shanghai'), 503, 'CONFIG_INVALID');
  }
  assert(Array.isArray(config.users) && config.users.length > 0 && config.users.length <= 100, 503, 'CONFIG_INVALID');
  const names = new Set();
  for (const u of config.users) {
    assert(typeof u.username === 'string' && u.username.length > 0 && u.username.length <= 80 && !names.has(u.username), 503, 'CONFIG_INVALID'); names.add(u.username);
    assert(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(u.passwordHash), 503, 'CONFIG_INVALID');
    assert(Array.isArray(u.devices) && u.devices.every((id) => ids.has(id)) && ['viewer', 'admin'].includes(u.role ?? 'viewer'), 503, 'CONFIG_INVALID');
  }
}
