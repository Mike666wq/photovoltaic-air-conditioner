import { describe, expect, it } from 'vitest';
import type { PlaybackFrame } from './playbackSession';
import { buildOperationalDiagnostics } from './operationalDiagnostics';

function frame(timestamp: number, values: Record<string, number>): PlaybackFrame {
  return {
    timestamp,
    anchorRowIndex: 0,
    samples: {},
    distancesMs: {},
    maxDistanceMs: 0,
    values,
    provenance: {},
  };
}

describe('统一时间窗运行诊断', () => {
  it('在严格共同帧上计算能量平衡、COP、电池能量与等效循环', () => {
    const start = new Date('2026-07-17T08:00:00+08:00').getTime();
    const values = {
      pv_power: 2,
      grid_active_power: 1,
      system_active_power: 2.5,
      battery_voltage: 50,
      battery_current: 10,
      battery_full_capacity_ah: 200,
      battery_soc: 10,
      water_flow: 1,
      supply_water_temp: 10,
      return_water_temp: 15,
      hp_power: 2,
    };
    const summary = buildOperationalDiagnostics([
      frame(start, values),
      frame(start + 30 * 60_000, values),
      frame(start + 60 * 60_000, values),
    ], 'positive-charge', { energyBalanceConfirmed: true });

    expect(summary.energyBalanceStatus).toBe('ready');
    expect(summary.balanceCoverage).toBe(1);
    expect(summary.meanAbsoluteBalanceKw).toBeCloseTo(0, 8);
    expect(summary.coolingEnergyKwh).toBeCloseTo(5.815, 6);
    expect(summary.heatPumpEnergyKwh).toBeCloseTo(2, 8);
    expect(summary.cop).toBeCloseTo(2.9075, 6);
    expect(summary.batteryChargeEnergyKwh).toBeCloseTo(0.5, 8);
    expect(summary.estimatedBatteryCapacityKwh).toBeCloseTo(10, 8);
    expect(summary.equivalentFullCycles).toBeCloseTo(0.025, 8);
    expect(summary.lowSocHours).toBeCloseTo(1, 8);
  });

  it('未确认计量边界时不猜测能量平衡，也不生成伪告警', () => {
    const summary = buildOperationalDiagnostics([
      frame(Date.now(), {
        pv_power: 6,
        grid_active_power: 5,
        system_active_power: 1,
        battery_voltage: 50,
        battery_current: 10,
      }),
    ], 'positive-charge');
    expect(summary.energyBalanceStatus).toBe('needs-configuration');
    expect(summary.balanceSampleCount).toBe(0);
    expect(summary.meanAbsoluteBalanceKw).toBeNull();
    expect(summary.events.some((event) => event.code === 'energy_balance')).toBe(false);
  });

  it('只提示异常，不改变数据，并合并连续同类事件', () => {
    const start = Date.now();
    const bad = {
      hp_power: 1.2,
      water_flow: 0,
      grid_active_power: 0.8,
      grid_voltage: 0,
      battery_soc: 6,
    };
    const summary = buildOperationalDiagnostics([
      frame(start, bad),
      frame(start + 2_000, bad),
    ], 'positive-charge');
    expect(summary.events.find((event) => event.code === 'hp_without_flow')?.count).toBe(2);
    expect(summary.events.some((event) => event.code === 'grid_power_offline' && event.severity === 'critical')).toBe(true);
    expect(summary.events.some((event) => event.code === 'soc_low')).toBe(true);
  });

  it('连续事件合并时保留最高严重度和最新证据', () => {
    const start = Date.now();
    const summary = buildOperationalDiagnostics([
      frame(start, { battery_soc: 12 }),
      frame(start + 1_000, { battery_soc: 6 }),
    ], 'positive-charge');
    const event = summary.events.find((item) => item.code === 'soc_low');
    expect(event).toMatchObject({ count: 2, severity: 'critical' });
    expect(event?.message).toContain('6.0%');
  });
});
