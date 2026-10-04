import { assert, object } from './contract.mjs';
import { opaque, tokenHash, passwordHash } from './auth.mjs';
import { equipment } from './experiment-contract.mjs';

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
  const module=body.module??'bms'; assert(['bms','experiment'].includes(module),400,'MODULE_INVALID','请选择BMS或实验监控模块');
  const permissions=module==='experiment'?{allowedEquipment:equipment(body.allowedEquipment)}:{allowedPacks:numbers(body.allowedPacks,16),allowedAddresses:numbers(body.allowedAddresses,255)};
  const deviceToken = opaque();
  return registry.mutate((next) => {
    assert(!next.devices.some((d) => d.deviceId === body.deviceId), 409, 'DEVICE_EXISTS', '设备编号已注册，请核对设备或使用令牌轮换');
    assert(next.devices.length < (registry.config.maxDevices ?? 20), 409, 'DEVICE_LIMIT', '已注册设备数达到上限');
    next.devices.push({ deviceId: body.deviceId, alias: body.alias.trim(), module, ...permissions, deviceTokenHash: tokenHash(deviceToken), allowSimulation: body.allowSimulation ?? false, displayTimeZone: 'Asia/Shanghai' });
    for (const user of next.users) if (user.role === 'admin') user.devices.push(body.deviceId);
    return { deviceId: body.deviceId, deviceToken };
  });
}
export async function registerUser(registry, body) {
  accountInput(body);
  assert(body.role == null || body.role === 'viewer', 403, 'ROLE_FORBIDDEN', '此入口只创建观看账户');
  assert(Array.isArray(body.devices) && body.devices.length <= 100 && body.devices.every((id) => typeof id === 'string'), 400, 'DEVICE_PERMISSION_INVALID', '设备授权列表无效');
  assert(body.monitoringAccess == null || typeof body.monitoringAccess === 'boolean', 400, 'MONITORING_PERMISSION_INVALID', '整体监控授权无效');
  const hash = await passwordHash(body.password);
  return registry.mutate((next) => {
    assert(!next.users.some((u) => u.username === body.username), 409, 'USER_EXISTS', '用户名已存在');
    assert(next.users.length < 100, 409, 'USER_LIMIT', '注册账户数达到上限');
    const devices = [...new Set(body.devices)];
    assert(devices.every((id) => next.devices.some((d) => d.deviceId === id)), 400, 'DEVICE_PERMISSION_INVALID', '授权设备不存在');
    next.users.push({ username: body.username, passwordHash: hash, role: 'viewer', devices, monitoringAccess: body.monitoringAccess ?? false, disabled: false });
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

export function deleteDevice(registry, deviceId, body) {
  assert(body.confirmDeviceId === deviceId, 400, 'CONFIRMATION_REQUIRED', '请确认需要删除的设备编号');
  return registry.mutate((next) => {
    assert(next.devices.some((d) => d.deviceId === deviceId), 404, 'DEVICE_NOT_FOUND', '设备不存在');
    next.devices = next.devices.filter((d) => d.deviceId !== deviceId);
    for (const user of next.users) user.devices = user.devices.filter((id) => id !== deviceId);
    if (next.system.experimentDeviceId === deviceId) next.system.experimentDeviceId = null;
    if (next.system.bmsDeviceId === deviceId) next.system.bmsDeviceId = null;
  });
}

export function updateUserDevices(registry, username, body) {
  assert(Array.isArray(body.devices)&&body.devices.length<=100&&body.devices.every(id=>typeof id==='string'),400,'DEVICE_PERMISSION_INVALID','授权设备列表无效');
  return registry.mutate(next=>{const user=next.users.find(u=>u.username===username);assert(user,404,'USER_NOT_FOUND','账户不存在');assert((user.role??'viewer')==='viewer',403,'ROLE_FORBIDDEN','此入口只修改观看账户授权');const ids=[...new Set(body.devices)];assert(ids.every(id=>next.devices.some(d=>d.deviceId===id)),400,'DEVICE_PERMISSION_INVALID','设备不存在');user.devices=ids;});
}

export function updateSystem(registry, body) {
  assert(object(body) && typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 128, 400, 'SYSTEM_NAME_INVALID', '系统名称需为1–128个字符');
  assert((body.experimentDeviceId == null || typeof body.experimentDeviceId === 'string') && (body.bmsDeviceId == null || typeof body.bmsDeviceId === 'string') && typeof body.allowSimulation === 'boolean', 400, 'SYSTEM_CONFIG_INVALID', '整体监控配置无效');
  return registry.mutate((next) => {
    for (const [field, module] of [['experimentDeviceId', 'experiment'], ['bmsDeviceId', 'bms']]) {
      const id = body[field];
      assert(id == null || next.devices.some((d) => d.deviceId === id && (d.module ?? 'bms') === module), 400, 'SYSTEM_DEVICE_INVALID', '绑定设备不存在或模块不匹配');
    }
    next.system = { name: body.name.trim(), experimentDeviceId: body.experimentDeviceId ?? null, bmsDeviceId: body.bmsDeviceId ?? null, allowSimulation: body.allowSimulation };
    return structuredClone(next.system);
  });
}

export function updateUserMonitoring(registry, username, body) {
  assert(object(body) && typeof body.monitoringAccess === 'boolean' && typeof body.disabled === 'boolean', 400, 'USER_ACCESS_INVALID', '账户整体权限或状态无效');
  return registry.mutate((next) => {
    const user = next.users.find((u) => u.username === username); assert(user, 404, 'USER_NOT_FOUND', '账户不存在');
    assert((user.role ?? 'viewer') !== 'admin' || !body.disabled, 400, 'ADMIN_DISABLE_FORBIDDEN', '不能停用管理员账户');
    user.monitoringAccess = body.monitoringAccess; user.disabled = body.disabled;
  });
}

export async function resetUserPassword(registry, username, body) {
  assert(object(body), 400, 'PASSWORD_INVALID', '新密码无效'); accountInput({ username, password: body.password });
  const hash = await passwordHash(body.password);
  return registry.mutate((next) => {
    const user = next.users.find((u) => u.username === username); assert(user, 404, 'USER_NOT_FOUND', '账户不存在');
    user.passwordHash = hash;
  });
}
