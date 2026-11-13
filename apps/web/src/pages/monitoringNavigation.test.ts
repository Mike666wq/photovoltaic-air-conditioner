import { describe, expect, it, vi } from 'vitest';
import { experimentCatalog } from '../services/experimentRealtimeTypes';
import type { BmsDevice } from '../services/bmsRealtimeTypes';
import { sortMonitoringDevices } from './MonitoringPage';
import { startForegroundDeviceRefresh } from './MonitoringDevicePage';

describe('监控导航目录与设备排序', () => {
  it('目录单一真源（采集端指纹版本）且保持全部点位绑定，单位以解码侧为准', () => {
    expect(experimentCatalog.catalogVersion).toMatch(/^catalog-4-[0-9A-F]{16}$/);
    expect(experimentCatalog.points).toHaveLength(37);
    const expected = new Map([
      ['D1', ['电压', 'V']], ['D2', ['电流', 'A']],
      // kW / kvar / kVA 是解码侧权威单位：chartFields.ts 一直按 kW 处理 D3，
      // 旧副本写 W 属于 1000 倍显示错误，已统一。
      ['D3', ['有功功率', 'kW']], ['D4', ['无功功率', 'kvar']], ['D5', ['视在功率', 'kVA']],
      ['DU1', ['市电电压', 'V']], ['DU2', ['市电电流', 'A']], ['DU3', ['有功功率', 'kW']],
      ['ZU6682', ['太阳能直流电压', 'V']], ['ZI6682', ['太阳能直流电流', 'A']],
    ]);
    for (const [id, [label, unit]] of expected) {
      const point = experimentCatalog.points.find(item => item.id === id)!;
      expect(point.metadata.Label).toBe(label);
      expect(point.metadata.Unit).toBe(unit);
    }
    // 倍率：ZU6682 已确认为 0.1；ZI6682 的 0.001 **尚未现场核实**，必须如实标 false
    const zu = experimentCatalog.points.find(item => item.id === 'ZU6682')!;
    expect(zu.metadata).toMatchObject({ Scale: 0.1, ScaleConfirmed: true });
    const zi = experimentCatalog.points.find(item => item.id === 'ZI6682')!;
    expect(zi.metadata).toMatchObject({ Scale: 0.001, ScaleConfirmed: false });
    const unknown = experimentCatalog.points.find(item => item.id === 'DU6')!;
    expect(unknown.metadata).toMatchObject({ Label: '市电功率因数', Unit: '', ScaleConfirmed: true, Scale: 1 });
    expect(experimentCatalog.points.some(point => point.metadata.Unit.includes('待核准'))).toBe(false);
    expect(experimentCatalog.points.map(point => `${point.equipmentId}/${point.id}`)).toContain('DDSU666/DU6');
    expect(experimentCatalog.points.filter(point => point.equipmentId === 'PLC' && point.metadata.Group === '运行状态').length).toBe(7);
  });

  it('同类型设备先展示在线连接，再按最近心跳排序，ID只作最终稳定排序', () => {
    const devices: BmsDevice[] = [
      { deviceId: 'old', alias: '旧设备', module: 'bms', allowedPacks: [], online: true, lastHeartbeatAt: '2026-01-01T00:00:00Z' },
      { deviceId: 'new', alias: '新设备', module: 'bms', allowedPacks: [], online: true, lastHeartbeatAt: '2026-02-01T00:00:00Z' },
      { deviceId: 'offline', alias: '离线设备', module: 'bms', allowedPacks: [], online: false, lastHeartbeatAt: null },
      { deviceId: 'experiment', alias: '实验设备', module: 'experiment', allowedPacks: [], online: false, lastHeartbeatAt: null },
    ];
    expect(sortMonitoringDevices(devices).map(device => device.deviceId)).toEqual(['experiment', 'new', 'old', 'offline']);
  });

  it('快捷设备目录前台每15秒刷新，恢复前台立即刷新且后台暂停', () => {
    vi.useFakeTimers();
    let foreground = false;
    let notifyForeground = () => {};
    let authorized = ['current-device', 'revoked-next-device'];
    const refresh = vi.fn(() => { authorized = ['current-device']; });
    const stop = startForegroundDeviceRefresh(refresh, () => foreground, listener => {
      notifyForeground = listener;
      return () => { notifyForeground = () => {}; };
    });
    try {
      expect(refresh).not.toHaveBeenCalled();
      foreground = true;
      notifyForeground();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(authorized).toEqual(['current-device']);
      vi.advanceTimersByTime(15000);
      expect(refresh).toHaveBeenCalledTimes(2);
      foreground = false;
      notifyForeground();
      vi.advanceTimersByTime(30000);
      expect(refresh).toHaveBeenCalledTimes(2);
      foreground = true;
      notifyForeground();
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
