import { beforeEach, describe, expect, it } from 'vitest';
import { prepareDataSource } from './dataSourcePipeline';
import {
  activateExperimentBatch,
  commitPreparedExperiment,
  configureActiveExperimentSession,
  previewExperimentSession,
} from './sessionCoordinator';
import { applyTimelineFrame } from './playbackController';
import { useAnalysisStore } from '../store/analysis';
import { useSimStore } from '../store/simulation';

function thermal(id: string, minute = 0) {
  return prepareDataSource({
    id,
    filename: `${id}.xlsx`,
    format: 'xlsx',
    headers: ['时间', 'T4.PV', 'T5.PV', 'D3.PV'],
    timeColumn: '时间',
    rows: [0, 1].map((offset) => ({
      时间: `2026-07-17 08:${String(minute + offset).padStart(2, '0')}:00`,
      'T4.PV': '12', 'T5.PV': '15', 'D3.PV': '2',
    })),
  });
}

function bms(id: string, minute = 0) {
  return prepareDataSource({
    id,
    filename: `${id}.xlsx`,
    format: 'xlsx',
    headers: ['时间', '电压(V)', '电流(A)', 'SOC(%)'],
    timeColumn: '时间',
    rows: [0, 1].map((offset) => ({
      时间: `2026-07-17 08:${String(minute + offset).padStart(2, '0')}:01`,
      '电压(V)': '50', '电流(A)': '5', 'SOC(%)': '70',
    })),
  });
}

describe('统一实验会话协调器', () => {
  beforeEach(() => {
    useAnalysisStore.getState().clearSources();
    useSimStore.getState().clearInjectionDataset();
    useSimStore.setState({ playbackToleranceMs: 2_000, playbackAnchorSourceId: null });
  });

  it('同一次提交原子建立分析来源、批次和原理图严格回放', () => {
    const sources = [thermal('thermal-a'), bms('bms-a')];
    const preview = previewExperimentSession(sources, { anchorSourceId: 'thermal-a', toleranceMs: 1_500 });
    expect(preview.blockers).toEqual([]);
    expect(preview.session?.frames).toHaveLength(2);

    const result = commitPreparedExperiment(sources, {
      batchId: 'batch-a', name: '工况 A', anchorSourceId: 'thermal-a', toleranceMs: 1_500,
    });
    const analysis = useAnalysisStore.getState();
    const simulation = useSimStore.getState();
    expect(result.batch).toMatchObject({ id: 'batch-a', sourceIds: ['thermal-a', 'bms-a'], toleranceMs: 1_500 });
    expect(analysis.sources).toHaveLength(2);
    expect(analysis.activeExperimentBatchId).toBe('batch-a');
    expect(analysis.analysisMode).toBe('union');
    expect(simulation.activePlaybackSourceIds).toEqual(['thermal-a', 'bms-a']);
    expect(simulation.playbackAnchorSourceId).toBe('thermal-a');
    expect(simulation.playbackSnapshot?.sourceIds).toEqual(['thermal-a', 'bms-a']);
  });

  it('不同批次保留来源但激活时只使用批次内部来源', () => {
    commitPreparedExperiment([thermal('thermal-a'), bms('bms-a')], { batchId: 'batch-a', name: 'A' });
    commitPreparedExperiment([thermal('thermal-b', 10), bms('bms-b', 10)], { batchId: 'batch-b', name: 'B' });
    expect(useAnalysisStore.getState().sources).toHaveLength(4);
    expect(useSimStore.getState().activePlaybackSourceIds).toEqual(['thermal-b', 'bms-b']);

    expect(activateExperimentBatch('batch-a')).toBe(true);
    expect(useSimStore.getState().activePlaybackSourceIds).toEqual(['thermal-a', 'bms-a']);
    expect(useAnalysisStore.getState().selectedSourceIds).toEqual(['thermal-a', 'bms-a']);
  });

  it('锚点和容差同步写入活动批次与回放状态', () => {
    commitPreparedExperiment([thermal('thermal-a'), bms('bms-a')], { batchId: 'batch-a', name: 'A' });
    expect(configureActiveExperimentSession('bms-a', 5_000)).toBe(true);
    expect(useAnalysisStore.getState().experimentBatches[0]).toMatchObject({ anchorSourceId: 'bms-a', toleranceMs: 5_000 });
    expect(useSimStore.getState()).toMatchObject({ playbackAnchorSourceId: 'bms-a', playbackToleranceMs: 5_000 });
  });

  it('原理图导入可不发布到数据分析库', () => {
    useAnalysisStore.getState().clearSources();
    const result = commitPreparedExperiment([thermal('thermal-private')], { publishToAnalysis: false });
    expect(result.sourceIds).toEqual(['thermal-private']);
    expect(useAnalysisStore.getState().sources).toEqual([]);
    expect(useAnalysisStore.getState().experimentBatches).toEqual([]);
    expect(useSimStore.getState().activePlaybackSourceIds).toEqual(['thermal-private']);
  });

  it.each([
    ['两个热工源', () => [thermal('thermal-a'), thermal('thermal-b')], ['thermal-a', 'thermal-b']],
    ['两个 BMS 源', () => [bms('bms-a'), bms('bms-b')], ['bms-a', 'bms-b']],
  ])('%s 默认进入共享严格同步帧，用户切换角色后可单源回放', (_label, makeSources, expectedIds) => {
    const sources = makeSources();
    commitPreparedExperiment(sources, { batchId: 'same-role-batch' });
    expect(useSimStore.getState().timelineMode).toBe('combined');
    expect(useSimStore.getState().playbackSnapshot?.sourceIds).toEqual(expectedIds);

    const role = sources[0].profile.kind;
    useSimStore.getState().setTimelineMode(role as 'thermal-electrical' | 'battery-bms');
    applyTimelineFrame(0);
    expect(useSimStore.getState().playbackSnapshot?.sourceIds).toEqual([expectedIds[0]]);
  });
});
