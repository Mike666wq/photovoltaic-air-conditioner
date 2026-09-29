import { beforeEach, describe, expect, it } from 'vitest';
import { useSimStore, derivePvOn } from './simulation';
import { PRESETS } from '../data/presets';

/**
 * pv_on 的权威性回归。
 *
 * 已验证：pv_power 是权威值，pv_on 是派生量。依据是控制面板只暴露 PV 功率滑块、
 * setField/togglePv/10 个预设全部成对维护该不变量、以及回放链路
 * services/schematicFrame.ts 用 setStatus('pv_on', power > 0.01) 派生。
 *
 * randomize() 曾是唯一破坏者：只写 pv_power 不写 pv_on，
 * 产出「有功率但光伏关闭」的矛盾存档，载入时又被归一化改回，
 * 表现为"保存再打开后状态变了"。
 */
describe('pv_on 是 pv_power 的派生量', () => {
  beforeEach(() => useSimStore.setState({
    controlMode: 'simulation',
    injectionFieldAvailability: {},
    playbackSnapshot: null,
  }));

  it('derivePvOn 在阈值两侧取正确值', () => {
    expect(derivePvOn(0)).toBe(false);
    expect(derivePvOn(0.01)).toBe(false);
    expect(derivePvOn(0.011)).toBe(true);
    expect(derivePvOn(4.85)).toBe(true);
  });

  it('randomize 之后不变量仍然成立（回归：曾产出矛盾存档）', () => {
    for (let i = 0; i < 30; i += 1) {
      useSimStore.getState().randomize();
      const { pv_power, pv_on } = useSimStore.getState();
      expect(pv_on).toBe(derivePvOn(pv_power));
    }
  });

  it('togglePv 两侧都成对更新', () => {
    useSimStore.setState({ pv_power: 4, pv_on: true });
    useSimStore.getState().togglePv();
    expect(useSimStore.getState()).toMatchObject({ pv_power: 0, pv_on: false });
    useSimStore.getState().togglePv();
    expect(useSimStore.getState().pv_on).toBe(true);
    expect(useSimStore.getState().pv_power).toBeGreaterThan(0.01);
  });

  it('全部预设自身都满足不变量', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.pv_on, `${name}: pv_power=${preset.pv_power} pv_on=${preset.pv_on}`)
        .toBe(derivePvOn(preset.pv_power));
    }
  });

  it('加载预设后不变量成立', () => {
    for (const name of Object.keys(PRESETS) as Array<keyof typeof PRESETS>) {
      useSimStore.getState().loadPreset(name);
      const { pv_power, pv_on } = useSimStore.getState();
      expect(pv_on, `预设 ${name}`).toBe(derivePvOn(pv_power));
    }
  });
});
