import { describe, expect, it } from 'vitest';
import type { MeterInstance } from '../data/meters';
import { useSimStore } from '../store/simulation';
import { buildMeterInjectData } from './meterInject';

describe('仪表注入', () => {
  it('静态模式的出风温度绑定读取末端温度而不是热泵内部温度', () => {
    const meter: MeterInstance = {
      id: 'ts-outlet-test', type: 'temp-sensor', bind: 'outlet-temp', mount: 'free',
      position: { x: 0, y: 0 },
    };
    const state = {
      ...useSimStore.getState(), injectionSources: [], at_temp: 19, hp_temp: 31,
    };
    expect(buildMeterInjectData(state, meter).fields.ts_value).toBe('19.0');
  });

  it('未绑定功率表显示明确空态而不是静默读取电表D', () => {
    const meter: MeterInstance = {
      id: 'pm-unbound', type: 'power-meter', mount: 'free', position: { x: 0, y: 0 },
    };
    const data = buildMeterInjectData(useSimStore.getState(), meter);
    expect(data.fields).toMatchObject({ pm_id: '未绑定', pm_l1_value: '—', pm_l3_value: '—' });
    expect(data.animations.pm_pulse_speed).toBe(0);
  });
});
