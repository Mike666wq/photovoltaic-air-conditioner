import { describe, expect, it } from 'vitest';
import { collectPlaybackImportBlockers, prepareDataSource } from './dataSourcePipeline';

const thermalHeaders = [
  '采样时刻', 'T0.PV', 'T1.PV', 'T2.PV', 'T3.PV', 'T4.PV', 'T5.PV',
  'D1.PV', 'D2.PV', 'D3.PV', 'D6.PV', 'DU1.PV', 'DU2.PV', 'DU3.PV', 'DU6.PV',
];

function thermalRow(time: string, override: Record<string, string> = {}): Record<string, string> {
  return {
    '采样时刻': time,
    'T0.PV': '20', 'T1.PV': '21', 'T2.PV': '22', 'T3.PV': '23', 'T4.PV': '24', 'T5.PV': '25',
    'D1.PV': '220', 'D2.PV': '3', 'D3.PV': '0.6', 'D6.PV': '0.98',
    'DU1.PV': '219', 'DU2.PV': '2.5', 'DU3.PV': '0.5', 'DU6.PV': '0.97',
    ...override,
  };
}

describe('数据源整理与质量报告', () => {
  it('保留原始行、字段映射和原始两分钟采样统计', () => {
    const inputRows = [
      thermalRow('2026/07/17 08:00:00'),
      thermalRow('2026/07/17 08:02:00'),
      thermalRow('2026/07/17 08:04:00'),
    ];
    const source = prepareDataSource({
      id: 'thermal', filename: 'thermal.xlsx', format: 'xlsx', headers: thermalHeaders, rows: inputRows,
    });
    expect(source.profile.kind).toBe('thermal-electrical');
    expect(source.fieldMappings.find((item) => item.sourceColumn === 'T4.PV')?.fieldKey).toBe('supply_water_temp');
    expect(source.timeStats.medianIntervalMs).toBe(120_000);
    expect(source.rows).toEqual(inputRows);
    expect(source.processedRows.every((row) => row.valid)).toBe(true);
  });

  it('缺列或温度槽出现电压级数值时隔离整行，且绝不移动原始字段', () => {
    const shifted = thermalRow('2026/07/17 17:00:00', { 'T4.PV': '220.4', 'DU6.PV': '' });
    const source = prepareDataSource({
      id: 'thermal', filename: 'thermal.xlsx', format: 'xlsx', headers: thermalHeaders, rows: [shifted],
    });
    expect(source.quality.invalidRows).toBe(1);
    expect(source.quality.issueCounts.temperature_voltage_misalignment).toBe(1);
    expect(source.quality.issueCounts.missing_field).toBe(1);
    expect(source.processedRows[0].invalidFields).toEqual(expect.arrayContaining(['T4.PV', 'DU6.PV']));
    expect(source.processedRows[0].raw['T4.PV']).toBe('220.4');
    expect(source.processedRows[0].raw['DU6.PV']).toBe('');
  });

  it('BMS 缺少单个非关键数值时保留时间行，但标记字段 invalid', () => {
    const source = prepareDataSource({
      id: 'bms', filename: 'bms.xlsx', format: 'xlsx',
      headers: ['时间', '电压(V)', '电流(A)', 'SOC(%)'],
      rows: [{ 时间: '2026/07/17 08:00:01', '电压(V)': '52', '电流(A)': '', 'SOC(%)': '30' }],
    });
    expect(source.profile.kind).toBe('battery-bms');
    expect(source.processedRows[0].valid).toBe(true);
    expect(source.processedRows[0].invalidFields).toEqual(['电流(A)']);
    expect(source.quality.invalidRows).toBe(0);
  });

  it('复用原理图模糊别名并桥接为大屏规范字段', () => {
    const source = prepareDataSource({
      id: 'generic', filename: 'generic.csv', format: 'csv',
      headers: ['采样时间', 'SOC percent', '循环水流量 (m³/h)'],
      rows: [{ 采样时间: '2026-07-17 08:00:00', 'SOC percent': '55', '循环水流量 (m³/h)': '1.2' }],
    });
    expect(source.fieldMappings).toEqual(expect.arrayContaining([
      { sourceColumn: 'SOC percent', fieldKey: 'battery_soc', confidence: 'fuzzy-alias' },
      { sourceColumn: '循环水流量 (m³/h)', fieldKey: 'water_flow', confidence: 'fuzzy-alias' },
    ]));
  });

  it('导入门禁拒绝缺时间、缺业务字段以及多源无交集', () => {
    const noTime = prepareDataSource({
      id: 'no-time', filename: 'no-time.csv', format: 'csv',
      headers: ['SOC(%)'], rows: [{ 'SOC(%)': '50' }],
    });
    const noField = prepareDataSource({
      id: 'no-field', filename: 'no-field.csv', format: 'csv',
      headers: ['时间', '备注'], rows: [{ 时间: '2026-07-17 08:00:00', 备注: '正常' }],
    });
    expect(collectPlaybackImportBlockers([noTime], 0)).toContain('no-time.csv：未识别到有效时间列');
    expect(collectPlaybackImportBlockers([noField], 0)).toContain('no-field.csv：未识别到可回放的业务字段');
    expect(collectPlaybackImportBlockers([noTime, noField], 0)).toContain('所选数据源在 ±2 秒条件下没有严格同步交集帧');
  });
});
