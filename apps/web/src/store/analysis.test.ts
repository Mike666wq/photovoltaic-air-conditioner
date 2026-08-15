import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BATTERY_CURRENT_CONVENTION, useAnalysisStore } from './analysis';

const source = (sourceFile: string, headers: string[]) => ({
  sourceFile,
  format: 'xlsx' as const,
  headers,
  rows: [{ 时间: '2026-07-17 08:11:19' }],
  timeColumn: '时间',
});

describe('analysis store 多来源筛选', () => {
  beforeEach(() => {
    useAnalysisStore.getState().clearSources();
    useAnalysisStore.setState({ analysisMode: 'union', batteryCurrentConvention: DEFAULT_BATTERY_CURRENT_CONVENTION });
  });

  it('导入来源后默认纳入并集，同时保留首个单源选择', () => {
    const process = useAnalysisStore.getState().addSource(source('process.xlsx', ['时间', 'T4.PV', 'D3.PV']));
    const bms = useAnalysisStore.getState().addSource(source('bms.xlsx', ['时间', '电压(V)', 'SOC(%)']));
    const state = useAnalysisStore.getState();

    expect(state.selectedSourceIds).toEqual([process.id, bms.id]);
    expect(state.singleSourceId).toBe(process.id);
    expect(state.analysisMode).toBe('intersection');
  });

  it('来源筛选可以排除再恢复，删除来源会清理悬空选择', () => {
    const process = useAnalysisStore.getState().addSource(source('process.xlsx', ['时间', 'T4.PV']));
    const bms = useAnalysisStore.getState().addSource(source('bms.xlsx', ['时间', 'SOC(%)']));

    useAnalysisStore.getState().toggleSourceSelection(bms.id);
    expect(useAnalysisStore.getState().selectedSourceIds).toEqual([process.id]);
    useAnalysisStore.getState().toggleSourceSelection(bms.id);
    expect(useAnalysisStore.getState().selectedSourceIds).toEqual([process.id, bms.id]);

    useAnalysisStore.getState().removeSource(process.id);
    expect(useAnalysisStore.getState().selectedSourceIds).toEqual([bms.id]);
    expect(useAnalysisStore.getState().singleSourceId).toBe(bms.id);
  });

  it('BMS 电流方向默认采用已确认的正值充电口径，仍允许用户改写', () => {
    expect(useAnalysisStore.getState().batteryCurrentConvention).toBe('positive-charge');
    useAnalysisStore.getState().setBatteryCurrentConvention('positive-discharge');
    expect(useAnalysisStore.getState().batteryCurrentConvention).toBe('positive-discharge');
  });

  it('首次形成双源组合后默认同步交集，之后不会覆盖用户的手动切换', () => {
    useAnalysisStore.getState().addSource(source('process.xlsx', ['时间', 'T4.PV']));
    useAnalysisStore.getState().addSource(source('bms.xlsx', ['时间', 'SOC(%)']));
    expect(useAnalysisStore.getState().analysisMode).toBe('intersection');

    useAnalysisStore.getState().setAnalysisMode('union');
    useAnalysisStore.getState().addSource(source('other.xlsx', ['时间', 'T5.PV']));
    expect(useAnalysisStore.getState().analysisMode).toBe('union');
  });

  it('导入时保留质量报告，异常温度电压错位行不会被标为有效', () => {
    const added = useAnalysisStore.getState().addSource({
      ...source('shifted.xlsx', ['时间', 'T4.PV', 'D3.PV']),
      rows: [{ 时间: '2026-07-17 17:00:00', 'T4.PV': '220.4', 'D3.PV': '1.2' }],
    });
    expect(added.quality.invalidRows).toBe(1);
    expect(added.processedRows[0].valid).toBe(false);
  });
});
