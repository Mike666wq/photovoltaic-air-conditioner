import { beforeEach, describe, expect, it } from 'vitest';
import { applyTimelineFrame, resolveRowsAtCursor } from '../components/TimelineControls';
import { useSimStore } from '../store/simulation';
import { readCell } from './meterInject';
import { parseDatasetTime } from './dataset';
import { prepareDataSource } from './dataSourcePipeline';

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
    activePlaybackSourceIds: [],
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
  it('复用上游 PreparedDataSource，不重复复制原始行和质量报告', () => {
    const prepared = prepareDataSource({
      id: 'shared-thermal',
      filename: 'thermal.xlsx',
      format: 'xlsx',
      headers: ['时间', 'T0.PV', 'T4.PV'],
      rows: thermalRows,
      timeColumn: '时间',
    });
    useSimStore.getState().setInjectionDataset({
      sourceId: prepared.id,
      sourceFile: prepared.filename,
      format: prepared.format,
      headers: prepared.headers,
      rows: prepared.rows,
      timeColumn: prepared.timeStats.timeColumn,
      role: prepared.profile.kind,
      prepared,
    });
    const dataset = useSimStore.getState().injectionDataset!;
    expect(dataset.prepared).toBe(prepared);
    expect(dataset.rawRows).toBe(prepared.rows);
    expect(dataset.rows[0]).toBe(prepared.processedRows[0].raw);
    expect(dataset.quality).toBe(prepared.quality);
  });

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
    // 与大屏统一：等距时稳定选择较早采样点 08:11:59。
    expect(useSimStore.getState().bat_soc).toBe(31);
    expect(readCell(useSimStore.getState(), '电压(V)')).toBe(52.1);
  });

  it('严格交集直接排除交集外主轴帧，不允许游标落到无同步数据的时刻', () => {
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'thermal.xlsx', format: 'xlsx', headers: ['时间', 'T0.PV', 'T4.PV'], rows: thermalRows,
      timeColumn: '时间', role: 'thermal-electrical', mapping: { 'T0.PV': 'pcm_temp' },
    });
    useSimStore.getState().setInjectionDataset({
      sourceFile: 'bms.xlsx', format: 'xlsx', headers: ['时间', 'SOC(%)', '电压(V)'], rows: bmsRows,
      timeColumn: '时间', role: 'battery-bms', mapping: { 'SOC(%)': 'bat_soc' },
    });
    applyTimelineFrame(0);
    expect(useSimStore.getState().injectionFieldAvailability.bat_soc).toBe(true);
    expect(useSimStore.getState().timelineCursorMs).toBe(parseDatasetTime('2026/07/17 08:12:00'));
    const resolved = resolveRowsAtCursor(
      useSimStore.getState(),
      parseDatasetTime('2026/07/17 08:00:00'),
      0,
    );
    expect(resolved.size).toBe(0);
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

  it('连续导入多批文件时只用显式激活的本批来源建立回放会话', () => {
    const sim = useSimStore.getState();
    sim.setInjectionDataset({
      sourceId: 'old-thermal', sourceFile: 'old-thermal.xlsx', format: 'xlsx',
      headers: ['时间', 'T0.PV'], rows: [{ 时间: '2026/07/16 08:00:00', 'T0.PV': '10' }],
      timeColumn: '时间', role: 'thermal-electrical',
    });
    useSimStore.getState().setInjectionDataset({
      sourceId: 'old-bms', sourceFile: 'old-bms.xlsx', format: 'xlsx',
      headers: ['时间', 'SOC(%)'], rows: [{ 时间: '2026/07/16 08:00:00', 'SOC(%)': '20' }],
      timeColumn: '时间', role: 'battery-bms',
    });
    useSimStore.getState().setInjectionDataset({
      sourceId: 'new-thermal', sourceFile: 'new-thermal.xlsx', format: 'xlsx',
      headers: ['时间', 'T0.PV'], rows: [{ 时间: '2026/07/17 09:00:00', 'T0.PV': '30' }],
      timeColumn: '时间', role: 'thermal-electrical',
    });
    useSimStore.getState().setInjectionDataset({
      sourceId: 'new-bms', sourceFile: 'new-bms.xlsx', format: 'xlsx',
      headers: ['时间', 'SOC(%)'], rows: [{ 时间: '2026/07/17 09:00:01', 'SOC(%)': '80' }],
      timeColumn: '时间', role: 'battery-bms',
    });
    useSimStore.getState().setActivePlaybackSourceIds(['new-thermal', 'new-bms']);
    useSimStore.getState().setTimelineMode('combined');
    applyTimelineFrame(0);

    const state = useSimStore.getState();
    expect(state.injectionSources).toHaveLength(4);
    expect(state.activePlaybackSourceIds).toEqual(['new-thermal', 'new-bms']);
    expect(state.timelineCursorMs).toBe(parseDatasetTime('2026/07/17 09:00:00'));
    expect(state.pcm_temp).toBe(30);
    expect(state.bat_soc).toBe(80);
    expect(state.playbackSnapshot?.sourceIds).toEqual(['new-thermal', 'new-bms']);
  });

  it('清空显式来源选择后退出回放，且不会继续使用旧数据集', () => {
    useSimStore.getState().setInjectionDataset({
      sourceId: 'thermal', sourceFile: 'thermal.xlsx', format: 'xlsx',
      headers: ['时间', 'T0.PV'], rows: thermalRows,
      timeColumn: '时间', role: 'thermal-electrical',
    });
    useSimStore.getState().setActivePlaybackSourceIds([]);
    applyTimelineFrame(0);

    const state = useSimStore.getState();
    expect(state.activePlaybackSourceIds).toEqual([]);
    expect(state.injectionDataset).toBeNull();
    expect(state.timelineIndex).toBe(-1);
    expect(state.timelineCursorMs).toBeNull();
    expect(state.controlMode).toBe('simulation');
    expect(state.playbackSnapshot).toBeNull();
  });
});
