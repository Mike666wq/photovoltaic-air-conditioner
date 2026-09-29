import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, PERSIST_SCHEMA_VERSION } from '../data/saveSchema';
import { useSimStore } from '../store/simulation';
import { useAnalysisStore } from '../store/analysis';
import { clearSourceCache } from './sourceCache';
import { prepareDataSource } from './dataSourcePipeline';
import { commitPreparedExperiment } from './sessionCoordinator';
import { applyTimelineFrame } from './playbackController';
import {
  applyDocumentToStore,
  DocumentValidationError,
  serializeState,
  validateDocument,
} from './stateSerializer';

describe('场景文档序列化与迁移', () => {
  beforeEach(async () => {
    await clearSourceCache();
    useAnalysisStore.getState().clearSources();
    useSimStore.setState({
      controlMode: 'simulation',
      playbackSnapshot: null,
      injectionDataset: null,
      injectionSources: [],
      injectionFieldAvailability: {},
      timelineIndex: -1,
      timelineCursorMs: null,
      timelinePlaying: false,
    });
  });

  it('新保存文档使用 v3，并能通过深校验', () => {
    const saved = serializeState('校验场景');
    expect(saved.schemaVersion).toBe(PERSIST_SCHEMA_VERSION);
    expect(validateDocument(saved)).toEqual(saved);
  });

  it('把缺少新字段的 v1 文档迁移为 v3 默认值', () => {
    const legacy = createEmptyDocument() as unknown as Record<string, any>;
    legacy.schemaVersion = 1;
    delete legacy.simulation.sac_water_level;
    delete legacy.simulation.sac_water_temp;
    delete legacy.simulation.sac_fan_speed;
    delete legacy.simulation.sac_outlet_temp;
    delete legacy.simulation.sac_on;
    delete legacy.preferences.snapToGrid;
    delete legacy.preferences.smartGuides;
    legacy.layout.cables = [{
      id: 'legacy-cable', kind: 'power',
      segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'inverter.left' }],
      floatingFrom: null, floatingTo: null,
    }];

    const migrated = validateDocument(legacy);
    expect(migrated.schemaVersion).toBe(PERSIST_SCHEMA_VERSION);
    expect(migrated.simulation).toMatchObject({ sac_water_level: 72, sac_on: true });
    expect(migrated.preferences).toMatchObject({ snapToGrid: true, smartGuides: true });
    expect(migrated.layout.cables[0]).toMatchObject({
      animationEnabled: true,
      direction: 'forward',
      directionMode: 'forward',
      routeMode: 'orthogonal-auto',
    });
  });

  it('把 v2 的不可恢复注入占位迁移为空会话', () => {
    const v2 = createEmptyDocument() as unknown as Record<string, any>;
    v2.schemaVersion = 2;
    v2.injection = { sourceFile: 'old.xlsx', injectedAt: '2026-07-17T00:00:00.000Z', rowsCount: 10 };
    const migrated = validateDocument(v2);
    expect(migrated.schemaVersion).toBe(PERSIST_SCHEMA_VERSION);
    expect(migrated.injection).toBeNull();
  });

  it('v3 场景只保存轻量清单，并能从缓存恢复实验批次', async () => {
    const prepared = prepareDataSource({
      id: 'cached-thermal', filename: 'cached-thermal.xlsx', format: 'xlsx',
      headers: ['时间', 'T4.PV', 'D3.PV'], timeColumn: '时间',
      rows: [{ 时间: '2026-07-17 08:00:00', 'T4.PV': '15', 'D3.PV': '2' }],
    });
    commitPreparedExperiment([prepared], { batchId: 'cached-batch', name: '缓存批次' });
    const saved = serializeState('带会话场景');
    expect(saved.injection).toMatchObject({ kind: 'experiment-session', activeBatchId: 'cached-batch' });
    expect(saved.injection?.sources[0]).not.toHaveProperty('rows');
    expect(JSON.stringify(saved).length).toBeLessThan(50_000);

    const previous = prepareDataSource({
      id: 'previous-source', filename: 'previous.xlsx', format: 'xlsx',
      headers: ['时间', 'T4.PV', 'D3.PV'], timeColumn: '时间',
      rows: [{ 时间: '2026-07-16 08:00:00', 'T4.PV': '10', 'D3.PV': '1' }],
    });
    commitPreparedExperiment([previous], { batchId: 'previous-batch' });
    const result = await applyDocumentToStore(validateDocument(saved));
    expect(result).toMatchObject({ dataSession: 'restored', missingSourceIds: [] });
    expect(useAnalysisStore.getState().activeExperimentBatchId).toBe('cached-batch');
    expect(useAnalysisStore.getState().sources.map((source) => source.id)).toEqual(['cached-thermal']);
    expect(useSimStore.getState().injectionSources.map((source) => source.sourceId)).toEqual(['cached-thermal']);
    expect(useSimStore.getState().playbackSnapshot?.sourceIds).toEqual(['cached-thermal']);
  });

  it('缓存缺失时保留场景布局并返回明确的重新导入提示', async () => {
    const current = prepareDataSource({
      id: 'current-source', filename: 'current.xlsx', format: 'xlsx',
      headers: ['时间', 'T4.PV'], timeColumn: '时间',
      rows: [{ 时间: '2026-07-17 08:00:00', 'T4.PV': '15' }],
    });
    commitPreparedExperiment([current], { batchId: 'current-batch' });
    const currentSnapshot = useSimStore.getState().playbackSnapshot;
    const doc = createEmptyDocument();
    doc.injection = {
      kind: 'experiment-session',
      activeBatchId: 'missing-batch',
      sources: [{
        sourceId: 'missing-source', cacheKey: 'missing-source', sourceFile: 'missing.xlsx',
        format: 'xlsx', role: 'thermal-electrical', rowsCount: 1, timeColumn: '时间',
      }],
      batches: [{
        id: 'missing-batch', name: '缺失批次', sourceIds: ['missing-source'],
        anchorSourceId: 'missing-source', toleranceMs: 2_000,
        createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
      }],
    };
    const result = await applyDocumentToStore(validateDocument(doc));
    expect(result).toMatchObject({ dataSession: 'missing', missingSourceIds: ['missing-source'] });
    expect(useAnalysisStore.getState().experimentBatches.map((batch) => batch.id)).toEqual(['current-batch']);
    expect(useSimStore.getState().injectionSources.map((source) => source.sourceId)).toEqual(['current-source']);
    expect(useSimStore.getState().playbackSnapshot).toEqual(currentSnapshot);
  });

  it('部分缓存只恢复完整批次，缺失批次不留下孤立来源', async () => {
    const available = prepareDataSource({
      id: 'available-source', filename: 'available.xlsx', format: 'xlsx',
      headers: ['时间', 'T4.PV'], timeColumn: '时间',
      rows: [{ 时间: '2026-07-17 08:00:00', 'T4.PV': '15' }],
    });
    commitPreparedExperiment([available], { batchId: 'available-batch' });
    const doc = serializeState('partial');
    doc.injection!.sources.push({
      sourceId: 'absent-source', cacheKey: 'absent-source', sourceFile: 'absent.xlsx',
      format: 'xlsx', role: 'thermal-electrical', rowsCount: 1, timeColumn: '时间',
    });
    doc.injection!.batches.push({
      id: 'absent-batch', name: '缺失批次', sourceIds: ['absent-source'],
      anchorSourceId: 'absent-source', toleranceMs: 2_000,
      createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    });

    useAnalysisStore.getState().clearSources();
    const result = await applyDocumentToStore(validateDocument(doc));
    expect(result).toMatchObject({ dataSession: 'partial', restoredBatchIds: ['available-batch'], missingSourceIds: ['absent-source'] });
    expect(useAnalysisStore.getState().experimentBatches.map((batch) => batch.id)).toEqual(['available-batch']);
    expect(useAnalysisStore.getState().sources.map((source) => source.id)).toEqual(['available-source']);
  });

  it('恢复多个完整批次的来源目录，但非活动批次单源回放不混组', async () => {
    const first = prepareDataSource({
      id: 'restored-a', filename: 'restored-a.xlsx', format: 'xlsx',
      headers: ['时间', 'T4.PV'], timeColumn: '时间',
      rows: [{ 时间: '2026-07-17 08:00:00', 'T4.PV': '15' }],
    });
    const second = prepareDataSource({
      id: 'restored-b', filename: 'restored-b.xlsx', format: 'xlsx',
      headers: ['时间', 'T4.PV'], timeColumn: '时间',
      rows: [{ 时间: '2026-07-18 08:00:00', 'T4.PV': '19' }],
    });
    commitPreparedExperiment([first], { batchId: 'restored-batch-a' });
    commitPreparedExperiment([second], { batchId: 'restored-batch-b' });
    const doc = serializeState('two-batches');

    useAnalysisStore.getState().clearSources();
    useSimStore.getState().clearInjectionDataset();
    const result = await applyDocumentToStore(validateDocument(doc));
    expect(result.restoredBatchIds).toEqual(['restored-batch-a', 'restored-batch-b']);
    expect(useSimStore.getState().injectionSources.map((source) => source.sourceId).sort()).toEqual(['restored-a', 'restored-b']);
    expect(useSimStore.getState().activePlaybackSourceIds).toEqual(['restored-b']);

    useSimStore.getState().setActivePlaybackSourceIds(['restored-a']);
    useSimStore.getState().setTimelineMode('thermal-electrical');
    applyTimelineFrame(0);
    expect(useSimStore.getState().playbackSnapshot?.sourceIds).toEqual(['restored-a']);
    expect(useAnalysisStore.getState().experimentBatches).toHaveLength(2);
  });

  it('拒绝非有限坐标、悬空线缆引用和引用环', () => {
    const invalidPoint = createEmptyDocument() as unknown as Record<string, any>;
    invalidPoint.layout.positions = { pv: { x: Number.NaN, y: 0 } };
    expect(() => validateDocument(invalidPoint)).toThrow(DocumentValidationError);

    const missingRef = createEmptyDocument() as unknown as Record<string, any>;
    missingRef.layout.cables = [{
      id: 'a', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [{ fromAnchorId: 'cable:missing.to', toAnchorId: 'load.left' }],
      floatingFrom: null, floatingTo: null,
    }];
    expect(() => validateDocument(missingRef)).toThrow(/不存在的线缆/);

    const cycle = createEmptyDocument() as unknown as Record<string, any>;
    cycle.layout.cables = [
      { id: 'a', kind: 'power', animationEnabled: true, direction: 'forward', floatingFrom: null, floatingTo: null,
        segments: [{ fromAnchorId: 'cable:b.to', toAnchorId: 'load.left' }] },
      { id: 'b', kind: 'power', animationEnabled: true, direction: 'forward', floatingFrom: null, floatingTo: null,
        segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'cable:a.from' }] },
    ];
    expect(() => validateDocument(cycle)).toThrow(/引用环/);
  });

  it('把旧 auto 方向冻结为保存时的人工方向', () => {
    const legacyAuto = createEmptyDocument() as unknown as Record<string, any>;
    legacyAuto.layout.cables = [{
      id: 'legacy-auto', kind: 'water', animationEnabled: true,
      direction: 'reverse', directionMode: 'auto',
      segments: [{ fromAnchorId: 'pump.right', toAnchorId: 'pcm.left' }],
      floatingFrom: null, floatingTo: null,
    }];
    expect(validateDocument(legacyAuto).layout.cables[0]).toMatchObject({
      direction: 'reverse', directionMode: 'reverse',
    });
  });

  it('拒绝不存在的节点锚点、缺少坐标的空端点和无效仪表挂载', () => {
    const unknownAnchor = createEmptyDocument() as unknown as Record<string, any>;
    unknownAnchor.layout.cables = [{
      id: 'bad-anchor', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [{ fromAnchorId: 'ghost.right', toAnchorId: 'load.left' }],
      floatingFrom: null, floatingTo: null,
    }];
    expect(() => validateDocument(unknownAnchor)).toThrow(/锚点不存在/);

    const missingFloating = createEmptyDocument() as unknown as Record<string, any>;
    missingFloating.layout.cables = [{
      id: 'bad-floating', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [{ fromAnchorId: '', toAnchorId: 'load.left' }],
      floatingFrom: null, floatingTo: null,
    }];
    expect(() => validateDocument(missingFloating)).toThrow(/浮动坐标/);

    const invalidMeterMount = createEmptyDocument() as unknown as Record<string, any>;
    invalidMeterMount.layout.meters = [{
      id: 'meter-bad', type: 'temp-sensor', mount: 'component',
      anchorId: 'ghost.top', position: { x: 1, y: 1 },
    }];
    expect(() => validateDocument(invalidMeterMount)).toThrow(/部件锚点不存在/);
  });

  it('打开不含会话的场景时保留已有回放会话', async () => {
    const snapshot = {
      timestamp: 1, values: { pv_power: 9 }, availability: { pv_power: true }, provenance: {},
      statuses: {}, statusAvailability: {}, sourceIds: [], sourceRowIndices: {}, sourceTimestamps: {},
    };
    useSimStore.setState({
      controlMode: 'replay',
      playbackSnapshot: snapshot,
      injectionSources: [{} as any],
      timelineIndex: 88,
      timelineCursorMs: 123,
      timelinePlaying: true,
      injectionFieldAvailability: { pv_power: true },
    });
    const doc = validateDocument(createEmptyDocument());
    doc.simulation.pv_power = 1.25;
    await applyDocumentToStore(doc);

    expect(useSimStore.getState()).toMatchObject({
      pv_power: 1.25,
      controlMode: 'replay',
      playbackSnapshot: snapshot,
      injectionSources: [{}],
      timelineIndex: 88,
      timelineCursorMs: 123,
      timelinePlaying: true,
      injectionFieldAvailability: { pv_power: true },
    });
  });
});
