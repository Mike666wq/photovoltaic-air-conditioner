import type {
  PreparedDataSource,
  ProcessedSourceRow,
} from './dataSourcePipeline';

/** 严格同步时某个来源在一帧中实际命中的采样。 */
export interface PlaybackSample {
  sourceId: string;
  sourceFile: string;
  timestamp: number;
  rowIndex: number;
  distanceMs: number;
  raw: Record<string, string>;
  /** 由 PreparedDataSource.fieldMappings 解析出的规范业务字段。 */
  values: Record<string, number>;
}

/** 帧级规范字段所采用的数据来源，便于 UI 解释值来自哪个文件和原始列。 */
export interface PlaybackValueProvenance {
  sourceId: string;
  sourceFile: string;
  sourceTimestamp: number;
  rowIndex: number;
  distanceMs: number;
  sourceColumn: string;
}

export interface PlaybackFrame {
  /** 统一帧时间；始终取主时间轴采样时间。 */
  timestamp: number;
  anchorRowIndex: number;
  samples: Record<string, PlaybackSample>;
  /** 各来源采样相对主时间的绝对偏差。 */
  distancesMs: Record<string, number>;
  maxDistanceMs: number;
  /** 按主源优先、其余来源按 sources 入参顺序合并的规范字段。 */
  values: Record<string, number>;
  provenance: Record<string, PlaybackValueProvenance>;
}

export interface PlaybackRange {
  start: number;
  end: number;
}

export interface PlaybackSession {
  anchorSourceId: string;
  sourceIds: string[];
  toleranceMs: number;
  range: PlaybackRange | null;
  frames: PlaybackFrame[];
  anchorCandidateCount: number;
  rejectedAnchorCount: number;
}

export interface BuildPlaybackSessionOptions {
  sources: PreparedDataSource[];
  anchorSourceId: string;
  /** 最近点最大容差；默认 2 秒。 */
  toleranceMs?: number;
}

export interface TimedPreparedRow {
  timestamp: number;
  rowIndex: number;
  raw: Record<string, string>;
  processed: ProcessedSourceRow;
}

interface CanonicalRowData {
  values: Record<string, number>;
  columns: Record<string, string>;
}

/**
 * 仅保留通过质量门禁且具有时间戳的行，并稳定按“时间、原始行号”排序。
 * 返回新数组，不改变 PreparedDataSource.processedRows 的文件原始顺序。
 */
export function getUsableTimedRows(source: PreparedDataSource): TimedPreparedRow[] {
  return source.processedRows
    .flatMap((processed) => processed.valid && processed.timestamp != null
      ? [{
        timestamp: processed.timestamp,
        rowIndex: processed.rowIndex,
        raw: processed.raw,
        processed,
      }]
      : [])
    .sort((left, right) => left.timestamp - right.timestamp || left.rowIndex - right.rowIndex);
}

/**
 * 在有序行中二分查找容差内最近点。
 * 距离相同时固定选择时间较早的采样；若时间也相同，再选文件中较早的行。
 */
export function findNearestPlaybackRow(
  rows: TimedPreparedRow[],
  targetTimestamp: number,
  toleranceMs: number,
): TimedPreparedRow | null {
  if (!Number.isFinite(targetTimestamp)) throw new Error('目标时间戳必须是有限数');
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error('时间匹配容差必须是非负有限数');
  }
  if (!rows.length) return null;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].timestamp < targetTimestamp) low = middle + 1;
    else high = middle;
  }

  const candidates = [rows[low - 1], rows[low]].filter(
    (row): row is TimedPreparedRow => row != null,
  );
  candidates.sort((left, right) => {
    const distanceDiff = Math.abs(left.timestamp - targetTimestamp) -
      Math.abs(right.timestamp - targetTimestamp);
    return distanceDiff || left.timestamp - right.timestamp || left.rowIndex - right.rowIndex;
  });
  const nearest = candidates[0];
  return Math.abs(nearest.timestamp - targetTimestamp) <= toleranceMs ? nearest : null;
}

function canonicalData(
  source: PreparedDataSource,
  row: Record<string, string>,
): CanonicalRowData {
  const values: Record<string, number> = {};
  const columns: Record<string, string> = {};
  for (const mapping of source.fieldMappings) {
    // 一个来源中多个列映射到同一规范字段时，按文件表头顺序稳定取第一列。
    if (Object.prototype.hasOwnProperty.call(values, mapping.fieldKey)) continue;
    const value = Number.parseFloat(String(row[mapping.sourceColumn] ?? '').trim());
    if (!Number.isFinite(value)) continue;
    values[mapping.fieldKey] = value;
    columns[mapping.fieldKey] = mapping.sourceColumn;
  }
  return { values, columns };
}

function validateSources(sources: PreparedDataSource[], anchorSourceId: string): void {
  if (!sources.length) throw new Error('严格同步至少需要一个数据源');
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) throw new Error(`数据源 id 重复：${source.id}`);
    sourceIds.add(source.id);
  }
  if (!sourceIds.has(anchorSourceId)) throw new Error(`主时间轴数据源不存在：${anchorSourceId}`);
}

/**
 * 为 N 个 PreparedDataSource 建立严格同步交集会话。
 *
 * - 主源的每个质量有效采样作为候选帧；
 * - 每个其它来源都必须在容差内命中最近点，否则整帧丢弃；
 * - 不补值、不前向填充、不修改原始行；
 * - 有效 range 从最终严格交集帧计算，不使用可能包含异常行的原始 timeStats；
 * - 规范字段冲突时主源优先，其余来源按 sources 入参顺序优先。
 */
export function buildPlaybackSession({
  sources,
  anchorSourceId,
  toleranceMs = 2_000,
}: BuildPlaybackSessionOptions): PlaybackSession {
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error('时间匹配容差必须是非负有限数');
  }
  validateSources(sources, anchorSourceId);

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const orderedSources = [
    sourceById.get(anchorSourceId)!,
    ...sources.filter((source) => source.id !== anchorSourceId),
  ];
  const rowsBySource = new Map(
    orderedSources.map((source) => [source.id, getUsableTimedRows(source)]),
  );
  const anchorRows = rowsBySource.get(anchorSourceId) ?? [];
  const frames: PlaybackFrame[] = [];

  for (const anchorRow of anchorRows) {
    const matchedRows = new Map<string, TimedPreparedRow>();
    matchedRows.set(anchorSourceId, anchorRow);
    let complete = true;
    for (const source of orderedSources.slice(1)) {
      const nearest = findNearestPlaybackRow(
        rowsBySource.get(source.id) ?? [],
        anchorRow.timestamp,
        toleranceMs,
      );
      if (!nearest) {
        complete = false;
        break;
      }
      matchedRows.set(source.id, nearest);
    }
    if (!complete) continue;

    const samples: Record<string, PlaybackSample> = {};
    const distancesMs: Record<string, number> = {};
    const values: Record<string, number> = {};
    const provenance: Record<string, PlaybackValueProvenance> = {};
    for (const source of orderedSources) {
      const row = matchedRows.get(source.id)!;
      const distanceMs = Math.abs(row.timestamp - anchorRow.timestamp);
      const canonical = canonicalData(source, row.raw);
      samples[source.id] = {
        sourceId: source.id,
        sourceFile: source.filename,
        timestamp: row.timestamp,
        rowIndex: row.rowIndex,
        distanceMs,
        raw: row.raw,
        values: canonical.values,
      };
      distancesMs[source.id] = distanceMs;
      for (const [fieldKey, value] of Object.entries(canonical.values)) {
        if (Object.prototype.hasOwnProperty.call(values, fieldKey)) continue;
        values[fieldKey] = value;
        provenance[fieldKey] = {
          sourceId: source.id,
          sourceFile: source.filename,
          sourceTimestamp: row.timestamp,
          rowIndex: row.rowIndex,
          distanceMs,
          sourceColumn: canonical.columns[fieldKey],
        };
      }
    }

    frames.push({
      timestamp: anchorRow.timestamp,
      anchorRowIndex: anchorRow.rowIndex,
      samples,
      distancesMs,
      maxDistanceMs: Math.max(...Object.values(distancesMs)),
      values,
      provenance,
    });
  }

  return {
    anchorSourceId,
    sourceIds: orderedSources.map((source) => source.id),
    toleranceMs,
    range: frames.length ? { start: frames[0].timestamp, end: frames[frames.length - 1].timestamp } : null,
    frames,
    anchorCandidateCount: anchorRows.length,
    rejectedAnchorCount: anchorRows.length - frames.length,
  };
}
