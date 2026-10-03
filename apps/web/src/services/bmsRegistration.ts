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
  return `BMS本地云连接配置（含私密上传令牌，请安全保存）\n服务根地址：${serviceRoot}\n设备编号 deviceId：${device.deviceId}\n设备上传令牌：${deviceToken}\n已注册地址 address：${device.allowedAddresses?.join(', ') ?? '请向管理员确认'}\n已注册Pack：${device.allowedPacks.join(', ')}\n\n本地配置步骤：\n1. 运行Windows BMS客户端，按仪器说明设置COM口、波特率等串口参数，并确认已读到真实数据。\n2. 在云连接设置中填入上述服务根地址、设备编号和上传令牌。服务地址只填域名根，不追加/api。\n3. 本地采集的地址及Pack需在已注册范围内；开启云连接，保持采集程序运行。\n4. 浏览器打开${serviceRoot}/bms/realtime，使用独立观看账户登录，选择设备与Pack并点击连接本地数据源。\n5. 通常等待下一次心跳（约15秒加网络耗时），网页收到采样后核对总压、电流、SOC及采样时间。\n6. 断开网页观看后上传停止，本地记录仍继续。网页不能启动EXE、打开串口或控制实验。\n\n本地通过HTTPS主动连接云端；不要关闭证书验证，不要同时让两台电脑使用同一设备编号。网页登录密码与设备上传令牌用途不同。\n`;
}
