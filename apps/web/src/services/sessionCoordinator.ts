import { matchColumnToField } from './dataMapper';
import {
  collectPlaybackImportBlockers,
  type PreparedDataSource,
} from './dataSourcePipeline';
import { buildPlaybackSession, type PlaybackSession } from './playbackSession';
import {
  createExperimentBatch,
  updateExperimentBatchConfig,
  type ExperimentBatch,
} from './experimentSession';
import { useAnalysisStore } from '../store/analysis';
import {
  useSimStore,
  type InjectionDataset,
  type TimelineMode,
} from '../store/simulation';
import { parseDatasetTime } from './dataset';
import { applyTimelineFrame } from './playbackController';
import { getCachedSource, putCachedSources } from './sourceCache';
import type { PersistedExperimentSessionManifest } from '../data/saveSchema';

export interface ExperimentSessionOptions {
  batchId?: string;
  name?: string;
  anchorSourceId?: string;
  toleranceMs?: number;
  /** 是否把本次原理图数据会话同时发布到数据分析库；默认发布。 */
  publishToAnalysis?: boolean;
}

export interface ExperimentSessionPreview {
  anchorSourceId: string | null;
  toleranceMs: number;
  session: PlaybackSession | null;
  blockers: string[];
}

export interface ExperimentCommitResult {
  batch: ExperimentBatch;
  session: PlaybackSession;
  sourceIds: string[];
}

export interface ExperimentRestoreReport {
  status: 'restored' | 'partial' | 'missing';
  restoredBatchIds: string[];
  missingSourceIds: string[];
}

export class ExperimentCommitError extends Error {
  constructor(public readonly blockers: string[]) {
    super(blockers.join('；'));
    this.name = 'ExperimentCommitError';
  }
}

function chooseAnchor(sources: PreparedDataSource[], requested?: string): PreparedDataSource | null {
  if (requested) {
    const selected = sources.find((source) => source.id === requested);
    if (selected) return selected;
  }
  return sources.find((source) =>
    source.profile.kind === 'thermal-electrical' || source.profile.kind === 'mixed',
  ) ?? sources[0] ?? null;
}

function timelineModeFor(sources: PreparedDataSource[]): TimelineMode {
  const hasThermal = sources.some((source) =>
    source.profile.kind === 'thermal-electrical' || source.profile.kind === 'mixed',
  );
  const hasBms = sources.some((source) =>
    source.profile.kind === 'battery-bms' || source.profile.kind === 'mixed',
  );
  if ((hasThermal && hasBms) || (sources.length > 1 && (hasThermal || hasBms))) return 'combined';
  return sources[0]?.profile.kind ?? 'generic';
}

/** 两个导入入口共用的提交前检查，预览与真正提交使用完全相同的锚点/容差。 */
export function previewExperimentSession(
  sources: PreparedDataSource[],
  options: ExperimentSessionOptions = {},
): ExperimentSessionPreview {
  const anchor = chooseAnchor(sources, options.anchorSourceId);
  const toleranceMs = Math.max(0, Math.min(60_000, Math.round(options.toleranceMs ?? 2_000)));
  const session = anchor
    ? buildPlaybackSession({ sources, anchorSourceId: anchor.id, toleranceMs })
    : null;
  return {
    anchorSourceId: anchor?.id ?? null,
    toleranceMs,
    session,
    blockers: collectPlaybackImportBlockers(sources, session?.frames.length ?? 0, toleranceMs),
  };
}

function toInjectionDataset(source: PreparedDataSource, injectedAt: string): InjectionDataset {
  const mapping = Object.fromEntries(source.headers.flatMap((header) => {
    const field = matchColumnToField(header);
    return field ? [[header, field]] : [];
  }));
  return {
    sourceId: source.id,
    sourceFile: source.filename,
    format: source.format,
    headers: source.headers,
    rows: source.processedRows.filter((row) => row.valid).map((row) => row.raw),
    rawRows: source.rows,
    quality: source.quality,
    prepared: source,
    timeColumn: source.timeStats.timeColumn,
    mapping,
    role: source.profile.kind,
    injectedAt,
  };
}

function commitSimulationSources(
  preparedSources: PreparedDataSource[],
  batch: ExperimentBatch,
  injectedAt: string,
): void {
  const state = useSimStore.getState();
  const added = preparedSources.map((source) => toInjectionDataset(source, injectedAt));
  const addedIds = new Set(added.map((source) => source.sourceId));
  const injectionSources = [
    ...state.injectionSources.filter((source) => !addedIds.has(source.sourceId)),
    ...added,
  ];
  const activePlaybackSourceIds = batch.sourceIds.filter((sourceId) =>
    injectionSources.some((source) => source.sourceId === sourceId),
  );
  const activeSources = activePlaybackSourceIds.flatMap((sourceId) => {
    const source = injectionSources.find((candidate) => candidate.sourceId === sourceId);
    return source ? [source] : [];
  });
  const preferred = activeSources.find((source) =>
    source.role === 'thermal-electrical' || source.role === 'mixed',
  ) ?? activeSources[0] ?? null;
  const rawTime = preferred?.timeColumn ? preferred.rows[0]?.[preferred.timeColumn] : undefined;
  useSimStore.setState({
    injectionSources,
    activePlaybackSourceIds,
    playbackAnchorSourceId: batch.anchorSourceId,
    playbackToleranceMs: batch.toleranceMs,
    injectionDataset: preferred,
    timelineMode: timelineModeFor(preparedSources),
    timelineIndex: preferred?.rows.length ? 0 : -1,
    timelineCursorMs: parseDatasetTime(rawTime),
    timelinePlaying: false,
    injectionFieldAvailability: {},
    controlMode: preferred ? 'replay' : 'simulation',
    playbackSnapshot: null,
    lastInjection: {
      sourceFile: preparedSources.length === 1 ? preparedSources[0].filename : `${preparedSources.length} 个文件`,
      rowsCount: preparedSources.reduce((sum, source) => sum + source.rows.length, 0),
      injectedAt,
    },
  });
}

/**
 * 原理图与大屏唯一的数据会话提交入口。
 * 解析结果只提交一次：分析页与原理图共享 PreparedDataSource 引用和同一个批次配置。
 */
export function commitPreparedExperiment(
  preparedSources: PreparedDataSource[],
  options: ExperimentSessionOptions = {},
): ExperimentCommitResult {
  const preview = previewExperimentSession(preparedSources, options);
  if (!preview.session || !preview.anchorSourceId || preview.blockers.length) {
    throw new ExperimentCommitError(preview.blockers.length ? preview.blockers : ['无法建立回放会话']);
  }
  const now = new Date().toISOString();
  const sourceIds = preparedSources.map((source) => source.id);
  // 同一组文件重复导入时复用既有批次，而不是再造一个 sourceIds 完全相同的新批次。
  // 数据源按 id 去重（analysis.addPreparedSources），但批次 id 每次随机生成，
  // 于是 A/B 下拉会堆满内容相同的批次，默认选中它们得到一屏 +0.000 的"自我对比"。
  const sourceKey = [...sourceIds].sort().join('|');
  const existingSameSources = options.batchId
    ? null
    : useAnalysisStore.getState().experimentBatches
        .find((item) => [...item.sourceIds].sort().join('|') === sourceKey);
  const batch = createExperimentBatch({
    id: options.batchId ?? existingSameSources?.id ?? `batch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    name: options.name ?? existingSameSources?.name ?? (preparedSources.length === 1
      ? preparedSources[0].filename.replace(/\.[^.]+$/, '')
      : `实验批次 ${useAnalysisStore.getState().experimentBatches.length + 1}`),
    sourceIds,
    anchorSourceId: preview.anchorSourceId,
    toleranceMs: preview.toleranceMs,
    timestamp: now,
  });

  if (options.publishToAnalysis !== false) {
    const analysis = useAnalysisStore.getState();
    analysis.addPreparedSources(preparedSources);
    useAnalysisStore.getState().upsertExperimentBatch(batch);
    useAnalysisStore.setState({
      selectedSourceIds: [...batch.sourceIds],
      singleSourceId: batch.sourceIds[0] ?? null,
      // 发布后进入大屏先展示已准备好的并集；严格交集由用户显式触发。
      analysisMode: 'union',
      range: null,
    });
  }
  commitSimulationSources(preparedSources, batch, now);
  // 内存层在函数返回前已写入；IndexedDB 持久化在后台完成，不阻塞首帧显示。
  void putCachedSources(preparedSources);
  applyTimelineFrame(0);
  return { batch, session: preview.session, sourceIds: [...batch.sourceIds] };
}

/** 按 v3 轻量清单从 IndexedDB 恢复；缓存缺失时只恢复完整批次并返回明确报告。 */
export async function restoreExperimentSession(
  manifest: PersistedExperimentSessionManifest,
  options: { replaceExisting?: boolean } = {},
): Promise<ExperimentRestoreReport> {
  const resolved = await Promise.all(manifest.sources.map(async (reference) => {
    const cached = await getCachedSource(reference.cacheKey);
    const valid = cached
      && cached.id === reference.sourceId
      && cached.filename === reference.sourceFile
      && cached.format === reference.format
      && cached.rows.length === reference.rowsCount;
    return { reference, source: valid ? cached : null };
  }));
  const availableSources = resolved.flatMap((item) => item.source ? [item.source] : []);
  const restoredSourceIds = new Set(availableSources.map((source) => source.id));
  const missingSourceIds = resolved.filter((item) => !item.source).map((item) => item.reference.sourceId);
  const restoredBatches = manifest.batches.filter((batch) =>
    batch.sourceIds.every((sourceId) => restoredSourceIds.has(sourceId)),
  );
  const restorableIds = new Set(restoredBatches.flatMap((batch) => batch.sourceIds));
  const restoredSources = availableSources.filter((source) => restorableIds.has(source.id));

  // 不能恢复任何完整批次时，保留当前可用会话。孤立的部分来源既不能组成时间轴，
  // 也不应被写入分析库；场景布局由调用方独立恢复。
  if (!restoredBatches.length) {
    return { status: 'missing', restoredBatchIds: [], missingSourceIds };
  }

  const analysis = useAnalysisStore.getState();
  // 只有确实恢复到数据源时才清空旧库。
  // 原先调用方（applyDocumentToStore）无条件先 clearSources() 再 await 恢复，
  // 两者之间存在真实空窗（getCachedSource 内部 await openDatabase）：
  // 一旦缓存缺失/不可用（隐私模式、file://、换机器打开别人的场景），
  // 打开新场景会先摧毁上一个会话的分析库，恢复失败只剩一条 toast，旧数据无法找回。
  if (options.replaceExisting && restoredSources.length) {
    analysis.clearSources();
    useSimStore.setState({
      injectionDataset: null,
      injectionSources: [],
      activePlaybackSourceIds: [],
      playbackAnchorSourceId: null,
      timelineCursorMs: null,
      timelineIndex: -1,
      timelinePlaying: false,
      injectionFieldAvailability: {},
      playbackSnapshot: null,
      lastInjection: null,
      controlMode: 'simulation',
    });
  }
  if (restoredSources.length) analysis.addPreparedSources(restoredSources);
  useAnalysisStore.setState({
    experimentBatches: restoredBatches.map((batch) => ({ ...batch, sourceIds: [...batch.sourceIds] })),
    activeExperimentBatchId: null,
  });
  // 注册全部完整批次的数据源，供大屏切到非活动批次中的单源模式。
  // activePlaybackSourceIds 仍由下方激活的一个批次决定，回放时间轴不会跨批次求交集。
  const cataloguedSources = restoredSources.map((source) => toInjectionDataset(source, new Date().toISOString()));
  const simulationSources = options.replaceExisting ? [] : useSimStore.getState().injectionSources;
  const sourceById = new Map(simulationSources.map((source) => [source.sourceId, source]));
  for (const source of cataloguedSources) sourceById.set(source.sourceId, source);
  useSimStore.setState({ injectionSources: [...sourceById.values()] });
  const preferredBatch = restoredBatches.find((batch) => batch.id === manifest.activeBatchId)
    ?? restoredBatches[0]
    ?? null;
  if (preferredBatch) activateExperimentBatch(preferredBatch.id);

  return {
    status: !restoredBatches.length ? 'missing' : missingSourceIds.length ? 'partial' : 'restored',
    restoredBatchIds: restoredBatches.map((batch) => batch.id),
    missingSourceIds,
  };
}

/** 激活已有批次；批次内严格同步，绝不与其它批次跨组求交集。 */
export function activateExperimentBatch(batchId: string): boolean {
  const analysis = useAnalysisStore.getState();
  const batch = analysis.experimentBatches.find((candidate) => candidate.id === batchId);
  if (!batch) return false;
  const prepared = batch.sourceIds.flatMap((sourceId) => {
    const source = analysis.sources.find((candidate) => candidate.id === sourceId);
    return source ? [source.prepared] : [];
  });
  if (prepared.length !== batch.sourceIds.length) return false;
  analysis.setActiveExperimentBatch(batch.id);
  useAnalysisStore.setState({
    selectedSourceIds: [...batch.sourceIds],
    singleSourceId: batch.sourceIds[0] ?? null,
    range: null,
  });
  commitSimulationSources(prepared, batch, new Date().toISOString());
  applyTimelineFrame(0);
  return true;
}

/** 同步更新活动批次和原理图回放配置。 */
export function configureActiveExperimentSession(anchorSourceId: string, toleranceMs: number): boolean {
  const analysis = useAnalysisStore.getState();
  const batch = analysis.experimentBatches.find((candidate) => candidate.id === analysis.activeExperimentBatchId);
  if (!batch) {
    useSimStore.getState().setPlaybackSessionConfig(anchorSourceId, toleranceMs);
    applyTimelineFrame(0);
    return false;
  }
  const updated = updateExperimentBatchConfig(batch, {
    anchorSourceId,
    toleranceMs,
    updatedAt: new Date().toISOString(),
  });
  analysis.upsertExperimentBatch(updated);
  useSimStore.getState().setPlaybackSessionConfig(updated.anchorSourceId, updated.toleranceMs);
  applyTimelineFrame(0);
  return true;
}
