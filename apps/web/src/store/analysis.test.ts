import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BATTERY_CURRENT_CONVENTION, useAnalysisStore } from './analysis';
import { prepareDataSource } from '../services/dataSourcePipeline';

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
    useAnalysisStore.setState({ analysisMode: 'union', analysisModeTouched: false, batteryCurrentConvention: DEFAULT_BATTERY_CURRENT_CONVENTION });
  });

  it('导入来源后默认纳入并集，同时保留首个单源选择', () => {
    const process = useAnalysisStore.getState().addSource(source('process.xlsx', ['时间', 'T4.PV', 'D3.PV']));
    const bms = useAnalysisStore.getState().addSource(source('bms.xlsx', ['时间', '电压(V)', 'SOC(%)']));
    const state = useAnalysisStore.getState();

    expect(state.selectedSourceIds).toEqual([process.id, bms.id]);
    expect(state.singleSourceId).toBe(process.id);
    expect(state.analysisMode).toBe('intersection');
  });

  it('批量提交共享整理结果且只保留同一份行数据', () => {
    const processInput = source('process.xlsx', ['时间', 'T4.PV']);
    const bmsInput = source('bms.xlsx', ['时间', 'SOC(%)']);
    const prepared = [processInput, bmsInput].map((input, index) => prepareDataSource({
      id: `prepared-${index}`,
      filename: input.sourceFile,
      format: input.format,
      headers: input.headers,
      rows: input.rows,
      timeColumn: input.timeColumn,
    }));

    const added = useAnalysisStore.getState().addPreparedSources(prepared);
    expect(added).toHaveLength(2);
    expect(added[0].prepared).toBe(prepared[0]);
    expect(added[0].rows).toBe(prepared[0].rows);
    expect(added[0].processedRows).toBe(prepared[0].processedRows);
    expect(useAnalysisStore.getState().analysisMode).toBe('intersection');

    const replacement = prepareDataSource({
      id: prepared[0].id,
      filename: prepared[0].filename,
      format: prepared[0].format,
      headers: prepared[0].headers,
      rows: [{ 时间: '2026-07-17 09:00:00', 'T4.PV': '26' }],
      timeColumn: '时间',
    });
    useAnalysisStore.getState().addPreparedSources([replacement]);
    const afterReplacement = useAnalysisStore.getState();
    expect(afterReplacement.sources).toHaveLength(2);
    expect(afterReplacement.sources.find((item) => item.id === replacement.id)?.rows).toBe(replacement.rows);
    expect(afterReplacement.selectedSourceIds).toHaveLength(2);
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

  it('导入进行中用户已切到单数据源时，后续来源提交不会覆盖选择', () => {
    useAnalysisStore.getState().addSource(source('process.xlsx', ['时间', 'T4.PV']));
    useAnalysisStore.getState().setAnalysisMode('single');
    useAnalysisStore.getState().addSource(source('bms.xlsx', ['时间', 'SOC(%)']));
    expect(useAnalysisStore.getState().analysisMode).toBe('single');
    expect(useAnalysisStore.getState().analysisModeTouched).toBe(true);
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
