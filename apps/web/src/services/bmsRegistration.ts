import type { BmsDeviceCredential } from './bmsRealtimeTypes';

export function registrationNumbers(text: string, maximum: number): number[] {
  const parts = text.trim().split(/[,，\s]+/);
  if (!text.trim() || !parts.every((p) => /^\d+$/.test(p))) throw new Error('请填写用逗号分隔的整数编号');
  const numbers = [...new Set(parts.map(Number))];
  if (numbers.length > 16 || numbers.some((n) => n < 1 || n > maximum)) throw new Error(`编号需在1–${maximum}内，最多16项`);
  return numbers.sort((a, b) => a - b);
}
export function connectionInstructions(credential: BmsDeviceCredential, serviceRoot: string): string {
  const { device, deviceToken } = credential;
  if(device.module==='experiment')return `实验客户端 Windows 手动配置说明（含私密上传令牌，请安全保存）\n服务根地址：${serviceRoot}\n设备编号 deviceId：${device.deviceId}\n采集模块：experiment\n设备上传令牌：${deviceToken}\n允许仪器：${device.allowedEquipment?.join(', ')}\n\n1. 在本机先确认串口采集和本地记录正常；稳定编号由实验客户端 settings/cloud.txt 保存。\n2. 在客户端云连接设置中手动填写服务根地址、deviceId 和令牌；只填域名根，不追加 /api。\n3. 开启云连接并保持采集；令牌由当前 Windows 用户 DPAPI 保护，换用户或电脑需重新填写，不要手工写明文。\n4. 登录 ${serviceRoot}/experiment/realtime，选择实验采集源并连接。心跳在线只证明客户端连通；须收到新鲜的实测点才算数据验证完成。\n5. 四台仪器依次观测，各点时间不相同，云端不会把它们当成同步的一轮。停止网页观看后上传暂停，本地 SQLite 记录继续。\n\n设备上传使用 /api/experiment/heartbeat 与 /api/experiment/snapshots；不使用旧 BMS 接口。网页不能控制 PLC 或串口。HTTPS 证书必须受信任，网页登录密码不能作为上传令牌。本说明供人工填写，不是客户端可导入的配置文件。\n`;
  return `BMS Windows 手动配置说明（含私密上传令牌，请安全保存）\n服务根地址：${serviceRoot}\n设备编号 deviceId：${device.deviceId}\n设备上传令牌：${deviceToken}\n已注册地址 address：${device.allowedAddresses?.join(', ') ?? '请向管理员确认'}\n已注册 Pack：${device.allowedPacks.join(', ')}\n\n1. 本机先按仪器说明设置 COM 口、波特率等参数，并确认采集到真实数据。\n2. 在客户端云连接设置中手动填写服务根地址、deviceId 和令牌；只填域名根，不追加 /api。\n3. 本地采集的地址与 Pack 必须在已注册范围内；开启云连接并保持采集程序运行。\n4. 登录 ${serviceRoot}/bms/realtime，选择设备与 Pack 并连接。心跳在线只证明客户端连通；须收到新鲜的实测点才算数据验证完成。\n5. 断开网页观看后上传暂停，本地记录继续。网页不能启动 EXE、打开串口或控制实验。\n\n本地通过 HTTPS 主动连接云端；不要关闭证书验证或让两台电脑共用一个 deviceId。网页登录密码与设备上传令牌用途不同。本说明供人工填写，不是客户端可导入的配置文件。\n`;
}
