import type { PreparedDataSource, ProcessedSourceRow } from './dataSourcePipeline';

export interface SessionRange {
  start: number;
  end: number;
}

export interface SessionRanges {
  union: SessionRange | null;
  intersection: SessionRange | null;
}

export interface SynchronizedFrame {
  timestamp: number;
  thermal: ProcessedSourceRow;
  bms: ProcessedSourceRow | null;
  bmsDistanceMs: number | null;
  inIntersection: boolean;
}

export interface SynchronizeOptions {
  /** 最近点容差；默认 2 秒。 */
  toleranceMs?: number;
  /** 默认隔离质量检查失败的热工主时间点和 BMS 候选点。 */
  includeInvalidRows?: boolean;
}

export function getSessionRanges(sources: PreparedDataSource[]): SessionRanges {
  const ranges = sources.flatMap((source) =>
    source.timeStats.start == null || source.timeStats.end == null
      ? []
      : [{ start: source.timeStats.start, end: source.timeStats.end }],
  );
  if (!ranges.length) return { union: null, intersection: null };
  const union = {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
  const intersectionStart = Math.max(...ranges.map((range) => range.start));
  const intersectionEnd = Math.min(...ranges.map((range) => range.end));
  return {
    union,
    intersection: intersectionStart <= intersectionEnd
      ? { start: intersectionStart, end: intersectionEnd }
      : null,
  };
}

function timedRows(source: PreparedDataSource, includeInvalidRows: boolean): ProcessedSourceRow[] {
  return source.processedRows
    .filter((row) => row.timestamp != null && (includeInvalidRows || row.valid))
    .sort((a, b) => a.timestamp! - b.timestamp!);
}

function findNearest(
  rows: ProcessedSourceRow[],
  target: number,
  startIndex: number,
): { row: ProcessedSourceRow | null; distance: number | null; nextIndex: number } {
  if (!rows.length) return { row: null, distance: null, nextIndex: 0 };
  let index = Math.min(startIndex, rows.length - 1);
  while (index + 1 < rows.length) {
    const currentDistance = Math.abs(rows[index].timestamp! - target);
    const nextDistance = Math.abs(rows[index + 1].timestamp! - target);
    if (nextDistance > currentDistance) break;
    index += 1;
  }
  return {
    row: rows[index],
    distance: Math.abs(rows[index].timestamp! - target),
    nextIndex: index,
  };
}

/**
 * 以热工/电表原始采样点为主时间轴，在双方时间交集内匹配最近 BMS 点。
 * 交集外、超出容差或质量无效时返回 bms=null，绝不前向填充。
 */
export function buildThermalMasterFrames(
  thermal: PreparedDataSource,
  bms: PreparedDataSource,
  options: SynchronizeOptions = {},
): SynchronizedFrame[] {
  const toleranceMs = options.toleranceMs ?? 2_000;
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error('时间匹配容差必须是非负有限数');
  }
  const includeInvalidRows = options.includeInvalidRows ?? false;
  const ranges = getSessionRanges([thermal, bms]);
  const masterRows = timedRows(thermal, includeInvalidRows);
  const bmsRows = timedRows(bms, includeInvalidRows);
  let bmsIndex = 0;

  return masterRows.map((thermalRow) => {
    const timestamp = thermalRow.timestamp!;
    const inIntersection = ranges.intersection != null &&
      timestamp >= ranges.intersection.start && timestamp <= ranges.intersection.end;
    if (!inIntersection) {
      return { timestamp, thermal: thermalRow, bms: null, bmsDistanceMs: null, inIntersection: false };
    }
    const nearest = findNearest(bmsRows, timestamp, bmsIndex);
    bmsIndex = nearest.nextIndex;
    const matched = nearest.row != null && nearest.distance != null && nearest.distance <= toleranceMs;
    return {
      timestamp,
      thermal: thermalRow,
      bms: matched ? nearest.row : null,
      bmsDistanceMs: matched ? nearest.distance : null,
      inIntersection: true,
    };
  });
}

