import { describe, expect, it } from 'vitest';
import type { Cable } from '../data/cables';
import { useSimStore } from '../store/simulation';
import { solvePowerSegment } from './powerFlow';

const cable = (id: string, from: string, to: string): Cable => ({
  id, kind: 'power', animationEnabled: true, direction: 'forward',
  segments: [{ fromAnchorId: from, toAnchorId: to }],
});

describe('电力拓扑功率流', () => {
  it('按功率守恒计算光伏、电池、负载和电网各支路', () => {
    const pv = cable('pv', 'pv-array.right', 'inverter.left');
    const battery = cable('battery', 'battery.left', 'inverter.right');
    const load = cable('load', 'inverter.bottom', 'load.left');
    const grid = cable('grid', 'grid.right', 'inverter.top');
    const state = {
      ...useSimStore.getState(), cables: [pv, battery, load, grid],
      pv_on: true, cb_connected: true, pv_power: 3,
      battery_power_kw: 1, load_on: true, load_power_kw: 2,
      grid_online: true, gs_on: true,
    };
    expect(solvePowerSegment(pv, 0, state).magnitudeKw).toBeCloseTo(3);
    expect(solvePowerSegment(pv, 0, state)).toMatchObject({ direction: 'forward', reason: 'flowing' });
    expect(solvePowerSegment(battery, 0, state).magnitudeKw).toBeCloseTo(1);
    expect(solvePowerSegment(battery, 0, state)).toMatchObject({ direction: 'forward', reason: 'flowing' });
    expect(solvePowerSegment(load, 0, state).magnitudeKw).toBeCloseTo(2);
    expect(solvePowerSegment(load, 0, state)).toMatchObject({ direction: 'forward', reason: 'flowing' });
    expect(solvePowerSegment(grid, 0, state).magnitudeKw).toBeCloseTo(2);
    expect(solvePowerSegment(grid, 0, state)).toMatchObject({ direction: 'reverse', reason: 'flowing' });
  });

  it('关闭的并网开关会切断上下游而不是继续传递粒子', () => {
    const grid = cable('grid', 'grid.right', 'grid-switch.left');
    const downstream = cable('downstream', 'grid-switch.right', 'inverter.top');
    const state = {
      ...useSimStore.getState(), cables: [grid, downstream], grid_online: true, gs_on: false,
    };
    expect(solvePowerSegment(grid, 0, state).reason).toBe('status-off');
    expect(solvePowerSegment(downstream, 0, state).reason).toBe('status-off');
  });

  it('光伏、电池与逆变器形成闭环时仍能求解动画', () => {
    const pvBus = cable('pv-bus', 'pv-array.right', 'bus.left');
    const busBattery = cable('bus-battery', 'bus.right', 'battery.left');
    const busInverter = cable('bus-inverter', 'bus.top', 'inverter.left');
    const batteryInverter = cable('battery-inverter', 'battery.right', 'inverter.right');
    const state = {
      ...useSimStore.getState(), cables: [pvBus, busBattery, busInverter, batteryInverter],
      pv_on: true, cb_connected: true, pv_power: 4, battery_power_kw: 0,
      grid_online: false, gs_on: false,
    };
    expect(solvePowerSegment(pvBus, 0, state).reason).toBe('flowing');
    expect(solvePowerSegment(busInverter, 0, state).reason).toBe('flowing');
  });

  it('cable 引用递归归一到被引用端点的真实组件节点', () => {
    const upstream = cable('upstream', 'pv-array.right', 'inverter.left');
    const branch = cable('branch', 'cable:upstream.to', 'load.left');
    const state = {
      ...useSimStore.getState(), cables: [upstream, branch],
      pv_on: true, cb_connected: true, pv_power: 2,
      load_on: true, load_power_kw: 2, grid_online: false, gs_on: false,
    };
    expect(solvePowerSegment(branch, 0, state)).toMatchObject({ reason: 'flowing', direction: 'forward' });
  });

  it('回放缺失电池功率时不读取残留手控功率', () => {
    const battery = cable('battery', 'battery.right', 'load.left');
    const state = {
      ...useSimStore.getState(), cables: [battery], controlMode: 'replay' as const,
      battery_power_kw: 3, load_on: true, load_power_kw: 3,
      playbackSnapshot: {
        timestamp: 1, values: { system_active_power: 3 }, availability: {}, provenance: {},
        statuses: { load_on: true }, statusAvailability: { load_on: true },
        sourceIds: [], sourceRowIndices: {}, sourceTimestamps: {},
      },
    };
    expect(solvePowerSegment(battery, 0, state).reason).toBe('data-unavailable');
  });
});
