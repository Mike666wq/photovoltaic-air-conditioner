/** 严格同步的默认最近点容差：2 秒。 */
export const DEFAULT_EXPERIMENT_TOLERANCE_MS = 2_000;

/** 试验批次允许的最大同步容差：60 秒。 */
export const MAX_EXPERIMENT_TOLERANCE_MS = 60_000;

/**
 * 一次试验批次的最小领域模型。
 *
 * 这里只保存数据源选择与同步配置，不保存原始行、回放帧或界面瞬态状态。
 */
export interface ExperimentBatch {
  id: string;
  name: string;
  sourceIds: string[];
  anchorSourceId: string;
  toleranceMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExperimentBatchInput {
  id: string;
  name: string;
  sourceIds: readonly string[];
  /** 缺省时使用去重后的第一个数据源。 */
  anchorSourceId?: string;
  toleranceMs?: number;
  /** 由调用方提供，保证领域函数不依赖系统时钟。 */
  timestamp: string;
}

export interface ReplaceBatchSourcesOptions {
  /** 缺省时优先保留原主时间轴；原主源已移除时使用新列表第一项。 */
  anchorSourceId?: string;
  /** 由调用方决定何时算作一次更新。 */
  updatedAt: string;
}

export interface UpdateExperimentBatchConfigInput {
  name?: string;
  anchorSourceId?: string;
  toleranceMs?: number;
  updatedAt: string;
}

export class ExperimentBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentBatchValidationError';
  }
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ExperimentBatchValidationError(`${field} 不能为空`);
  return normalized;
}

function requireTimestamp(value: string, field: string): string {
  const normalized = requireText(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new ExperimentBatchValidationError(`${field} 必须是有效时间`);
  }
  return normalized;
}

/** 去掉空白来源、修剪 id，并按首次出现顺序稳定去重。 */
export function normalizeExperimentSourceIds(sourceIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of sourceIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 只做无损规范化：修剪文本、稳定去重来源；不会擅自修改主时间轴或钳制容差。
 * 调用后仍应执行 validateExperimentBatch。
 */
export function normalizeExperimentBatch(batch: ExperimentBatch): ExperimentBatch {
  return {
    ...batch,
    id: batch.id.trim(),
    name: batch.name.trim(),
    sourceIds: normalizeExperimentSourceIds(batch.sourceIds),
    anchorSourceId: batch.anchorSourceId.trim(),
    createdAt: batch.createdAt.trim(),
    updatedAt: batch.updatedAt.trim(),
  };
}

/** 校验批次不变量；成功时返回原对象，便于函数式组合。 */
export function validateExperimentBatch(batch: ExperimentBatch): ExperimentBatch {
  requireText(batch.id, '批次 id');
  requireText(batch.name, '批次名称');
  requireTimestamp(batch.createdAt, '创建时间');
  requireTimestamp(batch.updatedAt, '更新时间');

  if (!batch.sourceIds.length) {
    throw new ExperimentBatchValidationError('试验批次至少需要一个数据源');
  }
  if (batch.sourceIds.some((id) => !id.trim())) {
    throw new ExperimentBatchValidationError('数据源 id 不能为空');
  }
  if (new Set(batch.sourceIds).size !== batch.sourceIds.length) {
    throw new ExperimentBatchValidationError('数据源 id 不能重复');
  }
  if (!batch.sourceIds.includes(batch.anchorSourceId)) {
    throw new ExperimentBatchValidationError('主时间轴必须属于当前数据源列表');
  }
  if (
    !Number.isFinite(batch.toleranceMs) ||
    batch.toleranceMs < 0 ||
    batch.toleranceMs > MAX_EXPERIMENT_TOLERANCE_MS
  ) {
    throw new ExperimentBatchValidationError(
      `同步容差必须位于 0..${MAX_EXPERIMENT_TOLERANCE_MS} ms`,
    );
  }
  return batch;
}

/** 规范化并校验，作为创建、替换与配置更新的共同出口。 */
function finalizeBatch(batch: ExperimentBatch): ExperimentBatch {
  const normalized = normalizeExperimentBatch(batch);
  return validateExperimentBatch(normalized);
}

/** 创建一个带默认 2 秒容差的试验批次。 */
export function createExperimentBatch(input: CreateExperimentBatchInput): ExperimentBatch {
  const sourceIds = normalizeExperimentSourceIds(input.sourceIds);
  return finalizeBatch({
    id: input.id,
    name: input.name,
    sourceIds,
    anchorSourceId: input.anchorSourceId?.trim() || sourceIds[0] || '',
    toleranceMs: input.toleranceMs ?? DEFAULT_EXPERIMENT_TOLERANCE_MS,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
}

/**
 * 原子替换批次的数据源集合。
 *
 * 若调用方未指定主源，且旧主源仍存在则继续使用；否则稳定回退到首个新来源。
 */
export function replaceBatchSources(
  batch: ExperimentBatch,
  sourceIdsInput: readonly string[],
  options: ReplaceBatchSourcesOptions,
): ExperimentBatch {
  const sourceIds = normalizeExperimentSourceIds(sourceIdsInput);
  const requestedAnchor = options.anchorSourceId?.trim();
  const anchorSourceId = requestedAnchor || (
    sourceIds.includes(batch.anchorSourceId) ? batch.anchorSourceId : sourceIds[0] || ''
  );
  return finalizeBatch({
    ...batch,
    sourceIds,
    anchorSourceId,
    updatedAt: options.updatedAt,
  });
}

/** 更新名称、主时间轴或同步容差，不改变来源与创建时间。 */
export function updateExperimentBatchConfig(
  batch: ExperimentBatch,
  input: UpdateExperimentBatchConfigInput,
): ExperimentBatch {
  return finalizeBatch({
    ...batch,
    name: input.name ?? batch.name,
    anchorSourceId: input.anchorSourceId ?? batch.anchorSourceId,
    toleranceMs: input.toleranceMs ?? batch.toleranceMs,
    updatedAt: input.updatedAt,
  });
}
