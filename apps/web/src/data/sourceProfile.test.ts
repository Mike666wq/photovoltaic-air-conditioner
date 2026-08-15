import { describe, expect, it } from 'vitest';
import { detectSourceProfile } from './sourceProfile';

describe('数据源能力识别', () => {
  it('按字段能力而不是扩展名识别力控与 BMS 数据', () => {
    expect(detectSourceProfile(['采样时刻', 'T0.PV', 'T4.PV', 'D1.PV', 'DU1.PV']).kind).toBe('thermal-electrical');
    expect(detectSourceProfile(['时间', '电压(V)', '电流(A)', 'SOC(%)', '剩余容量(Ah)']).kind).toBe('battery-bms');
  });
});
