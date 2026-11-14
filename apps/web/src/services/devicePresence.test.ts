import { describe, expect, it } from 'vitest';
import { describeDevicePresence, explainClientReport } from './devicePresence';
import type { BmsDevice } from './bmsRealtimeTypes';

const base: BmsDevice = {
  deviceId: 'lab-bms-01', alias: '实验室 BMS', allowedPacks: [1], online: false, lastHeartbeatAt: null,
};

describe('设备状态文案', () => {
  it('在线且时钟一致时不给多余提示', () => {
    const p = describeDevicePresence({ ...base, online: true, lastHeartbeatAt: '2026-11-14T02:00:00Z', firstSeenAt: '2026-11-14T01:00:00Z' });
    expect(p.label).toBe('心跳在线');
    expect(p.tone).toBe('online');
    expect(p.detail).toBe('');
  });

  it('时钟偏移超过 60 秒要提示——它是 TLS 校验失败的常见隐性原因', () => {
    const p = describeDevicePresence({ ...base, online: true, lastHeartbeatAt: '2026-11-14T02:00:00Z', clockSkewSec: -125 });
    expect(p.label).toBe('心跳在线');
    expect(p.detail).toContain('-125');
  });

  it('从未收到心跳 = 从未连接，不能笼统说成"离线"', () => {
    const p = describeDevicePresence(base);
    expect(p.label).toBe('从未连接');
    expect(p.tone).toBe('never');
    expect(p.detail).toContain('从未收到');
  });

  it('连过又断：给出漏检次数', () => {
    const p = describeDevicePresence({
      ...base, lastHeartbeatAt: '2026-11-14T01:00:00Z', firstSeenAt: '2026-11-14T00:00:00Z', missedBeats: 6,
    });
    expect(p.label).toBe('心跳离线');
    expect(p.detail).toContain('连续漏检 6 次');
  });

  it('设备自己说关了云连接，就照实说（这是确定事实）', () => {
    const p = describeDevicePresence({
      ...base, lastHeartbeatAt: '2026-11-14T01:00:00Z', firstSeenAt: '2026-11-14T00:00:00Z',
      missedBeats: 4, client: { cloudEnabled: false },
    });
    expect(p.detail).toContain('已关闭云连接');
  });

  it('没有自述时不许编造原因', () => {
    const p = describeDevicePresence({
      ...base, lastHeartbeatAt: '2026-11-14T01:00:00Z', firstSeenAt: '2026-11-14T00:00:00Z',
    });
    expect(p.detail).toContain('未上报原因');
  });
});

describe('自述翻译', () => {
  it('按阶段给出人话', () => {
    expect(explainClientReport({ lastError: { stage: 'DNS' } })).toContain('DNS');
    expect(explainClientReport({ lastError: { stage: 'TCP' } })).toContain('443');
    expect(explainClientReport({ lastError: { stage: 'TLS' } })).toContain('TLS');
  });

  it('HTTP 状态优先于阶段——401 是令牌问题不是网络问题', () => {
    expect(explainClientReport({ lastError: { stage: 'HTTP', httpStatus: 401 } })).toContain('令牌');
    expect(explainClientReport({ lastError: { stage: 'HTTP', httpStatus: 429 } })).toContain('限流');
    expect(explainClientReport({ lastError: { stage: 'HTTP', httpStatus: 502 } })).toContain('云端服务异常');
  });

  it('令牌解不开要单独说，它和网络故障的处置完全不同', () => {
    expect(explainClientReport({ tokenDecryptable: false })).toContain('无法由当前 Windows 用户解密');
  });

  it('没有自述时返回空串而不是猜', () => {
    expect(explainClientReport(null)).toBe('');
    expect(explainClientReport({ version: '1.2.8' })).toBe('');
  });
});
