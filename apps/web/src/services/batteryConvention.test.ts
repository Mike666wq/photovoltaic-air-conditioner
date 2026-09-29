// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { toSchematicBatteryPowerKw } from './batteryConvention';

const V = 52.4;   // 包电压
const I = 1.85;   // 包电流

describe('电池功率符号统一换算', () => {
  it('positive-charge（默认）：原始正电流=充电 → 内部负值=充电', () => {
    // 52.4 × 1.85 / 1000 = 0.09694 kW
    expect(toSchematicBatteryPowerKw(V, I, 'positive-charge')).toBeCloseTo(-0.09694, 5);
    // 负电流在正充电口径下代表放电 → 内部正值
    expect(toSchematicBatteryPowerKw(V, -I, 'positive-charge')).toBeCloseTo(0.09694, 5);
  });

  it('positive-discharge：原始正电流=放电 → 内部正值=放电', () => {
    expect(toSchematicBatteryPowerKw(V, I, 'positive-discharge')).toBeCloseTo(0.09694, 5);
    expect(toSchematicBatteryPowerKw(V, -I, 'positive-discharge')).toBeCloseTo(-0.09694, 5);
  });

  it('unknown 不猜测方向，返回 null（调用方按数据不可用处理）', () => {
    expect(toSchematicBatteryPowerKw(V, I, 'unknown')).toBeNull();
  });

  it('两种口径的绝对值恒等，方向恰好相反 —— 换算不丢信息', () => {
    const a = toSchematicBatteryPowerKw(V, I, 'positive-charge');
    const b = toSchematicBatteryPowerKw(V, I, 'positive-discharge');
    expect(Math.abs(a)).toBeCloseTo(Math.abs(b), 10);
    expect(Math.sign(a)).toBe(-Math.sign(b));
  });

  it('缺值或非有限数一律不产出功率', () => {
    expect(toSchematicBatteryPowerKw(undefined, I, 'positive-charge')).toBeNull();
    expect(toSchematicBatteryPowerKw(V, undefined, 'positive-charge')).toBeNull();
    expect(toSchematicBatteryPowerKw(NaN, I, 'positive-charge')).toBeNull();
    expect(toSchematicBatteryPowerKw(V, Infinity, 'positive-charge')).toBeNull();
  });

  it('零电流得到数值 0，且不会被误判成充/放电', () => {
    const charge = toSchematicBatteryPowerKw(V, 0, 'positive-charge');      // 取负 → -0
    const discharge = toSchematicBatteryPowerKw(V, 0, 'positive-discharge'); // 不取负 → +0
    // 两种口径的零在数值上等价（Object.is 区分 ±0，但 === 与 Math.abs 不区分）
    expect(charge === 0).toBe(true);
    expect(discharge === 0).toBe(true);
    expect(Math.abs(charge as number)).toBe(0);
    // deriveStaticBatteryMode 的阈值比较对 ±0 都判 idle
    expect(Math.abs(charge as number) > 0.01).toBe(false);
    expect(Math.abs(discharge as number) > 0.01).toBe(false);
  });

  it('默认参数等价于 positive-charge（DEFAULT_BATTERY_CURRENT_CONVENTION）', () => {
    expect(toSchematicBatteryPowerKw(V, I)).toBe(toSchematicBatteryPowerKw(V, I, 'positive-charge'));
  });
});
