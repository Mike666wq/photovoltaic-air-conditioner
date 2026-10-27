import { describe, expect, it, vi } from 'vitest';
import { experimentCatalog } from '../services/experimentRealtimeTypes';
import type { BmsDevice } from '../services/bmsRealtimeTypes';
import { sortMonitoringDevices } from './MonitoringPage';
import { startForegroundDeviceRefresh } from './MonitoringDevicePage';

describe('监控导航目录与设备排序', () => {
  it('目录升级到 catalog-2 且保持全部点位绑定，确定单位为正式单位', () => {
    expect(experimentCatalog.catalogVersion).toBe('catalog-2');
    expect(experimentCatalog.points).toHaveLength(37);
    const expected = new Map([
      ['D1', ['空调外机电压', 'V']], ['D2', ['空调外机电流', 'A']],
      ['D3', ['有功功率', 'W']], ['D4', ['无功功率', 'var']], ['D5', ['视在功率', 'VA']],
      ['DU1', ['市电电压', 'V']], ['DU2', ['市电电流', 'A']], ['DU3', ['有功功率', 'W']],
      ['ZU6682', ['太阳能直流电压', 'V']], ['ZI6682', ['太阳能直流电流', 'A']],
    ]);
    for (const [id, [label, unit]] of expected) {
      const point = experimentCatalog.points.find(item => item.id === id)!;
      expect(point.metadata.Label).toBe(label);
      expect(point.metadata.Unit).toBe(unit);
      expect(point.metadata.ScaleConfirmed).toBe(true);
      expect(point.metadata.Scale).toBe(1);
    }
    const unknown = experimentCatalog.points.find(item => item.id === 'DU6')!;
    expect(unknown.metadata).toMatchObject({ Label: '原始指标8202', Unit: '', ScaleConfirmed: true, Scale: 1 });
    expect(experimentCatalog.points.some(point => point.metadata.Unit.includes('待核准'))).toBe(false);
    expect(experimentCatalog.points.map(point => `${point.equipmentId}/${point.id}`)).toContain('DDSU666/DU6');
    expect(experimentCatalog.points.filter(point => point.equipmentId === 'PLC' && point.metadata.Group === '运行状态').length).toBe(11);
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
