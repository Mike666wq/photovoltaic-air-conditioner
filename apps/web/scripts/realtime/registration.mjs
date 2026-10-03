import { assert, object } from './contract.mjs';
import { opaque, tokenHash, passwordHash } from './auth.mjs';

export function setupStatus(config) {
  return { enabled: !!config.enabled, initialized: !!config.users?.length, writable: !!config.registryDir, bootstrapAvailable: !!config.enabled && !config.users?.length && !!config.registryDir && !!config.bootstrapHash, serviceRoot: config.publicOrigin ?? null };
}
export function accountInput(body) {
  assert(object(body) && typeof body.username === 'string' && /^[a-zA-Z0-9_.-]{3,80}$/.test(body.username), 400, 'USERNAME_INVALID', '用户名需3–80个英文字母、数字、点、下划线或短横线');
  assert(typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 256, 400, 'PASSWORD_INVALID', '密码需12–256个字符');
}
function numbers(values, max) {
  assert(Array.isArray(values) && values.length > 0 && values.length <= 16 && values.every((v) => Number.isInteger(v) && v >= 1 && v <= max), 400, 'REGISTRATION_RANGE_INVALID', '地址或Pack范围无效');
  return [...new Set(values)].sort((a, b) => a - b);
}
export async function registerDevice(registry, body) {
  assert(typeof body.deviceId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(body.deviceId), 400, 'DEVICE_ID_INVALID', '设备编号需与Windows客户端一致，仅允许字母、数字、下划线或短横线');
  assert(typeof body.alias === 'string' && body.alias.trim().length > 0 && body.alias.length <= 128, 400, 'ALIAS_INVALID', '请填写不超过128字符的设备名称');
  assert(body.allowSimulation == null || typeof body.allowSimulation === 'boolean');
  const allowedPacks = numbers(body.allowedPacks, 16), allowedAddresses = numbers(body.allowedAddresses, 255);
  const deviceToken = opaque();
  return registry.mutate((next) => {
    assert(!next.devices.some((d) => d.deviceId === body.deviceId), 409, 'DEVICE_EXISTS', '设备编号已注册，请核对设备或使用令牌轮换');
    assert(next.devices.length < (registry.config.maxDevices ?? 20), 409, 'DEVICE_LIMIT', '已注册设备数达到上限');
    next.devices.push({ deviceId: body.deviceId, alias: body.alias.trim(), allowedPacks, allowedAddresses, deviceTokenHash: tokenHash(deviceToken), allowSimulation: body.allowSimulation ?? false, displayTimeZone: 'Asia/Shanghai' });
    for (const user of next.users) if (user.role === 'admin') user.devices.push(body.deviceId);
    return { deviceId: body.deviceId, deviceToken };
  });
}
export async function registerUser(registry, body) {
  accountInput(body);
  assert(body.role == null || body.role === 'viewer', 403, 'ROLE_FORBIDDEN', '此入口只创建观看账户');
  assert(Array.isArray(body.devices) && body.devices.length > 0 && body.devices.length <= 100 && body.devices.every((id) => typeof id === 'string'), 400, 'DEVICE_PERMISSION_INVALID', '请选择至少一个授权设备');
  const hash = await passwordHash(body.password);
  return registry.mutate((next) => {
    assert(!next.users.some((u) => u.username === body.username), 409, 'USER_EXISTS', '用户名已存在');
    assert(next.users.length < 100, 409, 'USER_LIMIT', '注册账户数达到上限');
    const devices = [...new Set(body.devices)];
    assert(devices.every((id) => next.devices.some((d) => d.deviceId === id)), 400, 'DEVICE_PERMISSION_INVALID', '授权设备不存在');
    next.users.push({ username: body.username, passwordHash: hash, role: 'viewer', devices });
    return { username: body.username, role: 'viewer', devices };
  });
}
export function rotateDevice(registry, deviceId, body) {
  assert(body.confirmDeviceId === deviceId, 400, 'CONFIRMATION_REQUIRED', '请确认需要轮换的设备编号');
  const deviceToken = opaque();
  return registry.mutate((next) => {
    const device = next.devices.find((d) => d.deviceId === deviceId); assert(device, 404, 'DEVICE_NOT_FOUND', '设备不存在');
    device.deviceTokenHash = tokenHash(deviceToken); return { deviceId, deviceToken };
  });
}
