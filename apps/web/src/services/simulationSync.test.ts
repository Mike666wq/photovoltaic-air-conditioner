import { beforeEach, describe, expect, it } from 'vitest';
import { applyTimelineFrame, resolveRowsAtCursor } from '../components/TimelineControls';
import { useSimStore } from '../store/simulation';
import { readCell } from './meterInject';
import { parseDatasetTime } from './dataset';

const thermalRows = [
  { 时间: '2026/07/17 08:00:00', 'T0.PV': '20', 'T4.PV': '25' },
  { 时间: '2026/07/17 08:12:00', 'T0.PV': '21', 'T4.PV': '26' },
];

const bmsRows = [
  { 时间: '2026/07/17 08:11:59', 'SOC(%)': '31', '电压(V)': '52.1' },
  { 时间: '2026/07/17 08:12:01', 'SOC(%)': '32', '电压(V)': '52.2' },
];

beforeEach(() => {
  useSimStore.setState({
    injectionDataset: null,
    injectionSources: [],
    timelineMode: 'combined',
    timelineIndex: -1,
    timelineCursorMs: null,
    timelinePlaying: false,
    injectionFieldAvailability: {},
    pcm_temp: 28,
    bat_soc: 78,
  });
});

describe('原理图多源真实时间回放', () => {
  it('后导入 BMS 不覆盖热工主时间轴，并在 ±2 秒内同步最近点', () => {
    const store = useSimStore.getState();
    store.setInjectionDataset({
      sourceFile: 'thermal.xlsx', format: 'xlsx', headers: ['时间', 'T0.PV', 'T4.PV'], rows: thermalRows,
      timeColumn: '时间', role: 'thermal-electrical', mapping: { 'T0.PV': 'pcm_temp' },
    });
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'bms.xlsx', format: 'xlsx', headers: ['时间', 'SOC(%)', '电压(V)'], rows: bmsRows,
      timeColumn: '时间', role: 'battery-bms', mapping: { 'SOC(%)': 'bat_soc' },
    });

    expect(useSimStore.getState().injectionSources).toHaveLength(2);
    expect(useSimStore.getState().injectionDataset?.sourceFile).toBe('thermal.xlsx');
    applyTimelineFrame(1);
    expect(useSimStore.getState().pcm_temp).toBe(21);
    // 等距时 timeSession 稳定选择后一采样点 08:12:01。
    expect(useSimStore.getState().bat_soc).toBe(32);
    expect(readCell(useSimStore.getState(), '电压(V)')).toBe(52.2);
  });

  it('交集外 BMS 明确不可用，不沿用后来帧的旧值', () => {
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'thermal.xlsx', format: 'xlsx', headers: ['时间', 'T0.PV', 'T4.PV'], rows: thermalRows,
      timeColumn: '时间', role: 'thermal-electrical', mapping: { 'T0.PV': 'pcm_temp' },
    });
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'bms.xlsx', format: 'xlsx', headers: ['时间', 'SOC(%)', '电压(V)'], rows: bmsRows,
      timeColumn: '时间', role: 'battery-bms', mapping: { 'SOC(%)': 'bat_soc' },
    });
    applyTimelineFrame(1);
    expect(useSimStore.getState().injectionFieldAvailability.bat_soc).toBe(true);
    applyTimelineFrame(0);
    expect(useSimStore.getState().injectionFieldAvailability.bat_soc).toBe(false);
    expect(readCell(useSimStore.getState(), 'SOC(%)')).toBeNull();
    const resolved = resolveRowsAtCursor(
      useSimStore.getState(),
      parseDatasetTime('2026/07/17 08:00:00'),
      0,
    );
    expect(resolved.size).toBe(1);
  });

  it('BMS 专项模式使用自身 2 秒原始时间轴', () => {
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'thermal.xlsx', format: 'xlsx', headers: ['时间', 'T0.PV', 'T4.PV'], rows: thermalRows,
      timeColumn: '时间', role: 'thermal-electrical', mapping: { 'T0.PV': 'pcm_temp' },
    });
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'bms.xlsx', format: 'xlsx', headers: ['时间', 'SOC(%)', '电压(V)'], rows: bmsRows,
      timeColumn: '时间', role: 'battery-bms', mapping: { 'SOC(%)': 'bat_soc' },
    });
    useSimStore.getState().setTimelineMode('battery-bms');
    applyTimelineFrame(1);
    expect(useSimStore.getState().injectionDataset?.sourceFile).toBe('bms.xlsx');
    expect(useSimStore.getState().timelineCursorMs).toBe(parseDatasetTime('2026/07/17 08:12:01'));
    expect(useSimStore.getState().bat_soc).toBe(32);
    expect(useSimStore.getState().injectionFieldAvailability.bat_soc).toBe(true);
    expect(useSimStore.getState().injectionFieldAvailability.pcm_temp).toBe(false);
  });

  it('质量门禁隔离温度列出现电压值的错位行，同时保留原始行', () => {
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'bad.xlsx', format: 'xlsx', headers: ['时间', 'T4.PV'],
      rows: [
        { 时间: '2026/07/17 17:00:00', 'T4.PV': '220.4' },
        { 时间: '2026/07/17 17:02:00', 'T4.PV': '26.2' },
      ],
      timeColumn: '时间', role: 'thermal-electrical', mapping: { 'T4.PV': 'tank_temp' },
    });
    const source = useSimStore.getState().injectionDataset!;
    expect(source.rawRows).toHaveLength(2);
    expect(source.rows).toHaveLength(1);
    expect(source.quality.invalidRows).toBe(1);
  });
});
