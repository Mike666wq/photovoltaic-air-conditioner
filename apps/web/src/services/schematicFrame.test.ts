import { describe, expect, it } from 'vitest';
import { prepareDataSource } from './dataSourcePipeline';
import { buildPlaybackSession } from './playbackSession';
import { buildSchematicFrame } from './schematicFrame';

function frameFor(pcmTempSelect: 'T0' | 'T1') {
  const headers = [
    '时间', 'T0.PV', 'T1.PV', 'T2.PV', 'T3.PV', 'T4.PV', 'T5.PV',
    'hp_power', 'pump_flow', 'D3.PV', '电压(V)', '电流(A)', 'SOC(%)',
  ];
  const prepared = prepareDataSource({
    id: 'mixed',
    filename: 'mixed.csv',
    format: 'csv',
    headers,
    rows: [{
      时间: '2026-07-14 08:00:00',
      'T0.PV': '18',
      'T1.PV': '24',
      'T2.PV': '16',
      'T3.PV': '30',
      'T4.PV': '20',
      'T5.PV': '22',
      hp_power: '1.5',
      pump_flow: '1.2',
      'D3.PV': '2.4',
      '电压(V)': '50',
      '电流(A)': '10',
      'SOC(%)': '75',
    }],
  });
  const session = buildPlaybackSession({ sources: [prepared], anchorSourceId: prepared.id });
  return buildSchematicFrame(session.frames[0], { pcm_temp_select: pcmTempSelect });
}

describe('buildSchematicFrame', () => {
  it('独立保留 T0/T1，并按当前选择驱动 PCM', () => {
    const t0 = frameFor('T0');
    const t1 = frameFor('T1');
    expect(t0.snapshot.values.pcm_temp_1).toBe(18);
    expect(t0.snapshot.values.pcm_temp_2).toBe(24);
    expect(t0.measurements.pcm_temp).toBe(18);
    expect(t1.measurements.pcm_temp).toBe(24);
  });

  it('不再把送回水温覆盖到水箱温度，T2 只驱动末端温度', () => {
    const result = frameFor('T0');
    expect(result.measurements.at_temp).toBe(16);
    expect(result.measurements.hp_temp).toBeUndefined();
    expect(result.measurements.tank_temp).toBeUndefined();
    expect(result.snapshot.values.supply_water_temp).toBe(20);
    expect(result.snapshot.values.return_water_temp).toBe(22);
  });

  it('统一 BMS 与原理图电池功率符号并派生运行状态', () => {
    const result = frameFor('T0');
    expect(result.measurements.battery_power_kw).toBe(-0.5);
    expect(result.measurements.bat_soc).toBe(75);
    expect(result.statuses.hp_on).toBe(true);
    expect(result.statuses.pump_on).toBe(true);
    expect(result.statuses.load_on).toBe(true);
    expect(result.statuses.at_mode).toBe('cool');
    expect(result.snapshot.statusAvailability.cb_connected).toBe(false);
    expect(result.snapshot.statusAvailability.gs_on).toBe(false);
    expect(result.snapshot.statuses.cb_connected).toBe('unknown');
    expect(result.snapshot.statuses.gs_on).toBe('unknown');
    expect(result.statuses.cb_connected).toBeUndefined();
    expect(result.statuses.gs_on).toBeUndefined();
  });
});
