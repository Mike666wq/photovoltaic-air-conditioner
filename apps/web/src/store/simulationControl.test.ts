import { beforeEach, describe, expect, it } from 'vitest';
import { useSimStore } from './simulation';

describe('手控与回放写入边界', () => {
  beforeEach(() => useSimStore.setState({
    controlMode: 'simulation',
    playbackSnapshot: null,
    injectionFieldAvailability: {},
    pv_power: 3,
    pv_on: true,
    timelinePlaying: false,
  }));

  it('静态手控功率仍同步 PV 开关', () => {
    useSimStore.getState().setField('pv_power', 0);
    expect(useSimStore.getState()).toMatchObject({ pv_power: 0, pv_on: false });
  });

  it('回放中修改未采集数值不得联动篡改设备状态', () => {
    useSimStore.setState({ controlMode: 'replay', injectionFieldAvailability: {}, pv_on: false });
    useSimStore.getState().setField('pv_power', 2);
    expect(useSimStore.getState()).toMatchObject({ pv_power: 2, pv_on: false });
  });

  it('回放中拒绝覆盖当前帧已经提供的字段，退出后恢复手控', () => {
    useSimStore.setState({ controlMode: 'replay', injectionFieldAvailability: { pv_power: true } });
    useSimStore.getState().setField('pv_power', 5);
    expect(useSimStore.getState().pv_power).toBe(3);

    useSimStore.getState().exitReplay();
    useSimStore.getState().setField('pv_power', 0);
    expect(useSimStore.getState()).toMatchObject({
      controlMode: 'simulation', pv_power: 0, pv_on: false, injectionFieldAvailability: {},
    });
  });
});

