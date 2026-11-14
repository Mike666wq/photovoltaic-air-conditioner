import type { BmsClientReport, BmsDevice } from './bmsRealtimeTypes';

/**
 * 「这台设备现在怎样」——把服务端观测到的事实，翻译成一句能指导动作的话。
 *
 * 纪律（与 AWS / Azure 的文档一致）：
 *   · 「确定」只用于服务端亲自观测到的事实：最后一次心跳时刻、漏了几拍、HTTP 状态码。
 *   · 「推测」必须带「可能」并给一条可执行动作，不能把猜测写成结论。
 *   · 缺字段 = 未知，不等于正常。
 */
export type PresenceTone = 'online' | 'never' | 'offline';

export interface PresenceDescription {
  /** 状态短标签，用于设备卡片 */
  label: string;
  tone: PresenceTone;
  /** 一句可执行的原因说明；在线且无异常时为空串 */
  detail: string;
}

/** 把设备自述翻译成人话。没有自述或自述无异常时返回空串（不编造原因）。 */
export function explainClientReport(client?: BmsClientReport | null): string {
  if (!client) return '';
  // 这四条是「设备自己说的」，属于确定事实，优先级最高。
  if (client.cloudEnabled === false) return '设备本地已关闭云连接';
  if (client.tokenDecryptable === false) return '已保存的令牌无法由当前 Windows 用户解密，需在本机重新输入';
  const e = client.lastError;
  if (e) {
    if (e.httpStatus === 401 || e.httpStatus === 403) return '云端拒绝：令牌失效，或设备编号与令牌不匹配';
    if (e.httpStatus === 429) return '被云端限流，可能存在重复的客户端';
    if (e.httpStatus && e.httpStatus >= 500) return '云端服务异常（网关或服务端报错）';
    switch (e.stage) {
      case 'DNS': return 'DNS 解析失败：解析不到服务地址';
      case 'PROXY': return '代理不可用或代理要求认证';
      case 'TCP': return 'TCP 443 不可达（连接超时或被拒绝）';
      case 'TLS': return 'TLS 握手失败或证书不受信任';
      case 'AUTH': return '鉴权失败';
      case 'PROTOCOL': return '响应无法解析，协议版本可能不匹配';
      case 'SERIAL': return '采集侧异常（串口或 Modbus）';
      default: return '';
    }
  }
  // 有自述、有成功记录，但心跳断了：只能是链路或进程的问题，属于推测。
  if (client.lastSuccessUtc) return '程序曾正常运行，之后连不上云端（可能断电、断网或进程已退出）';
  return '';
}

export function describeDevicePresence(device: BmsDevice): PresenceDescription {
  const firstSeen = device.firstSeenAt ?? null;
  const everSeen = Boolean(firstSeen || device.lastHeartbeatAt);

  if (device.online) {
    const skew = device.clockSkewSec;
    const detail = skew != null && Math.abs(skew) > 60
      ? `本机时钟与云端相差 ${skew > 0 ? '+' : ''}${skew} 秒`
      : '';
    return { label: '心跳在线', tone: 'online', detail };
  }

  // 从未见过心跳：多半是编号写错、令牌没配、或 443 没放通——都不在设备自述能覆盖的范围内。
  if (!everSeen) {
    return {
      label: '从未连接',
      tone: 'never',
      detail: '云端从未收到该编号的心跳：请核对设备编号与令牌，并确认现场能访问 443',
    };
  }

  const missed = device.missedBeats;
  const beats = typeof missed === 'number' && missed > 0 ? `已连续漏检 ${missed} 次心跳` : '';
  const reason = explainClientReport(device.client);
  const detail = [reason, beats].filter(Boolean).join('；');
  return { label: '心跳离线', tone: 'offline', detail: detail || '设备未上报原因，需现场确认' };
}
