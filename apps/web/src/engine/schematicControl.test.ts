import { describe, expect, it } from 'vitest';
import type { Cable } from '../data/cables';
import { useSimStore, type SimulationState } from '../store/simulation';
import {
  deriveCableSegmentFlow,
  deriveInverterMode,
  deriveSelectedPcmVisual,
  deriveSemanticPowerDirection,
  deriveStaticBatteryFlowDirection,
  deriveStaticBatteryMode,
  fanSpeedLabel,
  isCableEnergized,
  powerCableBaseFlow,
} from './schematicControl';

const controlState = {
  pv_on: true,
  cb_connected: true,
  pv_power: 3,
  grid_online: true,
  gs_on: true,
  battery_power_kw: 0,
} as const;

const powerCable: Cable = {
  id: 'test-power', kind: 'power', animationEnabled: true, direction: 'forward',
  segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'combiner-box.left' }],
};

describe('原理图控制派生', () => {
  it('静态 PV 功率与运行开关联动，避免有功率却无线缆动画', () => {
    useSimStore.setState({ controlMode: 'simulation', pv_on: false, pv_power: 0 });
    useSimStore.getState().setField('pv_power', 3.24);
    expect(useSimStore.getState()).toMatchObject({ pv_power: 3.24, pv_on: true });
    useSimStore.getState().togglePv();
    expect(useSimStore.getState()).toMatchObject({ pv_power: 0, pv_on: false });
  });

  it('统一静态电池功率正放电、负充电', () => {
    expect(deriveStaticBatteryMode(1)).toBe('discharging');
    expect(deriveStaticBatteryFlowDirection(1)).toBe('out');
    expect(deriveStaticBatteryMode(-1)).toBe('charging');
    expect(deriveStaticBatteryFlowDirection(-1)).toBe('in');
    expect(deriveStaticBatteryMode(0)).toBe('idle');
  });

  it('逆变器模式由电源与电池功率派生', () => {
    expect(deriveInverterMode(controlState)).toBe('dc-to-ac');
    expect(deriveInverterMode({ ...controlState, pv_on: false, pv_power: 0, battery_power_kw: 1 })).toBe('dc-to-ac');
    expect(deriveInverterMode({ ...controlState, pv_on: false, pv_power: 0, battery_power_kw: -1 })).toBe('ac-to-dc');
    expect(deriveInverterMode({ ...controlState, pv_on: false, pv_power: 0, battery_power_kw: 0 })).toBe('idle');
  });

  it('末端档位文字覆盖停到强四档', () => {
    expect(fanSpeedLabel(0, 'cool')).toBe('停');
    expect(fanSpeedLabel(1, 'heat')).toBe('低');
    expect(fanSpeedLabel(2, 'cool')).toBe('中');
    expect(fanSpeedLabel(3, 'cool')).toBe('高');
    expect(fanSpeedLabel(4, 'cool')).toBe('强');
    expect(fanSpeedLabel(4, 'off')).toBe('停');
  });

  it('选中的实测 PCM 温度驱动相态', () => {
    const pcmState = { tank_temp: 20, pump_on: true, pump_flow: 2, pcm_temp: 10 };
    expect(deriveSelectedPcmVisual(pcmState, 10).phase).toBe('freezing');
    expect(deriveSelectedPcmVisual(pcmState, 50).phase).toBe('liquid');
  });

  it('电力线受直接连接部件开关门控且零流归零', () => {
    const state = {
      ...controlState,
      load_on: true, hp_on: true, at_mode: 'cool', sac_on: true,
      load_power_kw: 1, hp_power: 2,
    } as SimulationState;
    expect(isCableEnergized(powerCable, state)).toBe(true);
    expect(powerCableBaseFlow(powerCable, state)).toBeCloseTo(0.5);
    expect(isCableEnergized(powerCable, { ...state, pv_on: false })).toBe(false);
    expect(powerCableBaseFlow(powerCable, { ...state, cb_connected: false })).toBe(0);
  });
});

describe('逐段线缆流向', () => {
  const batteryCable: Cable = {
    id: 'battery-line', kind: 'power', animationEnabled: true, direction: 'forward',
    segments: [{ fromAnchorId: 'battery.right', toAnchorId: 'load.left' }],
  };

  it('线缆方向不再随电池充放电自动反转', () => {
    const base = useSimStore.getState();
    const discharge = deriveCableSegmentFlow(batteryCable, 0, {
      ...base, cables: [batteryCable], battery_power_kw: 2, load_power_kw: 2, load_on: true,
    });
    const charge = deriveCableSegmentFlow(batteryCable, 0, {
      ...base, cables: [batteryCable], battery_power_kw: -2, load_power_kw: 2, load_on: true,
    });
    expect(discharge.direction).toBe('forward');
    expect(charge.direction).toBe('forward');
  });

  it('人工方向覆盖自动功率方向', () => {
    const base = useSimStore.getState();
    const forced = deriveCableSegmentFlow({ ...batteryCable, directionMode: 'reverse' }, 0, {
      ...base, cables: [batteryCable], battery_power_kw: 2, load_power_kw: 2, load_on: true,
    });
    expect(forced.active).toBe(true);
    expect(forced.direction).toBe('reverse');
  });

  it('自动方向采用设备语义，中间仪表段保持画线方向', () => {
    const base = { ...useSimStore.getState(), pv_on: true, pv_power: 3, battery_power_kw: -2 };
    expect(deriveSemanticPowerDirection('pv-array', 'meter-pv', base)).toBe('forward');
    expect(deriveSemanticPowerDirection('meter-load', 'load', base)).toBe('forward');
    expect(deriveSemanticPowerDirection('battery', 'meter-battery', base)).toBe('reverse');
    expect(deriveSemanticPowerDirection('meter-a', 'inverter', base)).toBeNull();
  });

  it('静态仿真中无独立功率测点的仪表到水泵支路仍按电力线流量动画', () => {
    const base = useSimStore.getState();
    const pumpPower: Cable = {
      id: 'pump-power', kind: 'power', animationEnabled: true,
      direction: 'forward', directionMode: 'auto',
      segments: [{ fromAnchorId: 'meter-pump.right', toAnchorId: 'pump.top' }],
    };
    const flowing = deriveCableSegmentFlow(pumpPower, 0, {
      ...base, cables: [pumpPower], pump_on: true, pl_flow: 2,
    });
    expect(flowing).toMatchObject({ active: true, direction: 'forward', reason: 'flowing' });
    expect(deriveCableSegmentFlow(pumpPower, 0, {
      ...base, cables: [pumpPower], pump_on: true, pl_flow: 0,
    }).active).toBe(true);
  });

  it('人工动画在回放缺少 GS 遥信时仍保持开启', () => {
    const base = useSimStore.getState();
    const gridCable: Cable = {
      ...batteryCable,
      segments: [{ fromAnchorId: 'grid.right', toAnchorId: 'grid-switch.left' }],
    };
    const result = deriveCableSegmentFlow(gridCable, 0, {
      ...base,
      controlMode: 'replay',
      cables: [gridCable],
      playbackSnapshot: {
        timestamp: 1, values: { grid_active_power: 1 }, availability: {}, provenance: {}, statuses: {},
        statusAvailability: { grid_online: true, gs_on: false }, sourceIds: [], sourceRowIndices: {}, sourceTimestamps: {},
      },
    });
    expect(result.active).toBe(true);
    expect(result.reason).toBe('flowing');
  });

  it('旧自动方向场景迁移前仍沿用其保存方向', () => {
    const base = useSimStore.getState();
    const water: Cable = {
      id: 'water', kind: 'water', animationEnabled: true, direction: 'reverse', directionMode: 'auto',
      segments: [{ fromAnchorId: 'pump.right', toAnchorId: 'pcm.left' }],
    };
    const refrigerant: Cable = {
      id: 'refrigerant', kind: 'refrigerant', animationEnabled: true, direction: 'reverse', directionMode: 'auto',
      segments: [{ fromAnchorId: 'tank.left', toAnchorId: 'heat-pump.right' }],
    };
    expect(deriveCableSegmentFlow(water, 0, { ...base, cables: [water], pump_on: true, pump_flow: 2 }).direction).toBe('reverse');
    expect(deriveCableSegmentFlow(refrigerant, 0, { ...base, cables: [refrigerant], hp_on: true, hp_power: 2 }).direction).toBe('reverse');
  });

  it('人工动画开启后不再被 PV 自动状态拦截', () => {
    const base = useSimStore.getState();
    const pvToCombiner: Cable = {
      id: 'pv-input', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'combiner-box.left' }],
    };
    const combinerToInverter: Cable = {
      id: 'pv-output', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [
        { fromAnchorId: 'combiner-box.right', toAnchorId: 'meter-pv.left' },
        { fromAnchorId: 'meter-pv.right', toAnchorId: 'inverter.left' },
      ],
    };
    const cables = [pvToCombiner, combinerToInverter];
    const stopped = {
      ...base, cables, pv_power: 3.24, pv_on: false, cb_connected: true, pl_flow: 3,
    };
    expect(deriveCableSegmentFlow(combinerToInverter, 0, stopped).reason).toBe('flowing');
    expect(deriveCableSegmentFlow(combinerToInverter, 1, stopped).reason).toBe('flowing');

    const running = { ...stopped, pv_on: true };
    expect(deriveCableSegmentFlow(combinerToInverter, 0, running).reason).toBe('flowing');
    expect(deriveCableSegmentFlow(combinerToInverter, 1, running).reason).toBe('flowing');
  });
});
