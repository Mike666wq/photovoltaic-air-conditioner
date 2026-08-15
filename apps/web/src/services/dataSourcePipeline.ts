import { CHART_FIELDS, normalizeChartHeader } from '../data/chartFields';
import { detectSourceProfile, type SourceProfile } from '../data/sourceProfile';
import { detectTimeColumn, parseDatasetTime } from './dataset';

export type SourceFormat = 'csv' | 'xlsx' | 'pdf';

export interface SourceFieldMapping {
  sourceColumn: string;
  fieldKey: string;
  confidence: 'exact-alias';
}

export interface SourceTimeStats {
  timeColumn?: string;
  start: number | null;
  end: number | null;
  validTimestampCount: number;
  invalidTimestampCount: number;
  uniqueTimestampCount: number;
  duplicateTimestampCount: number;
  medianIntervalMs: number | null;
  minimumIntervalMs: number | null;
  maximumIntervalMs: number | null;
  gapCount: number;
}

export type QualityIssueCode =
  | 'missing_timestamp'
  | 'duplicate_timestamp'
  | 'missing_field'
  | 'invalid_number'
  | 'temperature_voltage_misalignment';

export interface RowQualityIssue {
  code: QualityIssueCode;
  field?: string;
  message: string;
}

export interface ProcessedSourceRow {
  /** 文件内数据行的零基序号；不包含表头。 */
  rowIndex: number;
  /** 原始行完整保留，质量检查不会猜测、平移或改写单元格。 */
  raw: Record<string, string>;
  timestamp: number | null;
  valid: boolean;
  invalidFields: string[];
  issues: RowQualityIssue[];
}

export interface SourceQualityReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  invalidFieldCount: number;
  issueCounts: Partial<Record<QualityIssueCode, number>>;
}

export interface PreparedDataSource {
  id: string;
  filename: string;
  format: SourceFormat;
  headers: string[];
  /** 原始采样行及其原始频率，不做重采样或补值。 */
  rows: Array<Record<string, string>>;
  profile: SourceProfile;
  fieldMappings: SourceFieldMapping[];
  timeStats: SourceTimeStats;
  quality: SourceQualityReport;
  processedRows: ProcessedSourceRow[];
}

export interface PrepareDataSourceInput {
  id: string;
  filename: string;
  format: SourceFormat;
  headers: string[];
  rows: Array<Record<string, string>>;
  timeColumn?: string;
}

const TEMPERATURE_KEYS = new Set([
  'pcm_temp_1',
  'pcm_temp_2',
  'outlet_temp',
  'ambient_temp',
  'supply_water_temp',
  'return_water_temp',
]);

function buildFieldMappings(headers: string[]): SourceFieldMapping[] {
  const result: SourceFieldMapping[] = [];
  for (const header of headers) {
    const normalizedHeader = normalizeChartHeader(header);
    const field = CHART_FIELDS.find((candidate) =>
      candidate.aliases.some((alias) => normalizeChartHeader(alias) === normalizedHeader),
    );
    if (field) {
      result.push({ sourceColumn: header, fieldKey: field.key, confidence: 'exact-alias' });
    }
  }
  return result;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function buildTimeStats(
  rows: Array<Record<string, string>>,
  timeColumn: string | undefined,
): SourceTimeStats {
  const timestamps = rows.map((row) => timeColumn ? parseDatasetTime(row[timeColumn]) : null);
  const valid = timestamps.filter((value): value is number => value != null).sort((a, b) => a - b);
  const unique = [...new Set(valid)];
  const intervals = unique.slice(1).map((value, index) => value - unique[index]).filter((value) => value > 0);
  const medianIntervalMs = median(intervals);
  return {
    timeColumn,
    start: valid[0] ?? null,
    end: valid.length ? valid[valid.length - 1] : null,
    validTimestampCount: valid.length,
    invalidTimestampCount: rows.length - valid.length,
    uniqueTimestampCount: unique.length,
    duplicateTimestampCount: valid.length - unique.length,
    medianIntervalMs,
    minimumIntervalMs: intervals.length ? Math.min(...intervals) : null,
    maximumIntervalMs: intervals.length ? Math.max(...intervals) : null,
    gapCount: medianIntervalMs == null
      ? 0
      : intervals.filter((interval) => interval > medianIntervalMs * 3).length,
  };
}

function addIssue(
  issues: RowQualityIssue[],
  invalidFields: Set<string>,
  issue: RowQualityIssue,
): void {
  issues.push(issue);
  if (issue.field) invalidFields.add(issue.field);
}

function inspectRow(
  row: Record<string, string>,
  rowIndex: number,
  timeColumn: string | undefined,
  mappings: SourceFieldMapping[],
  profile: SourceProfile,
  duplicateTimestamps: ReadonlySet<number>,
): ProcessedSourceRow {
  const timestamp = timeColumn ? parseDatasetTime(row[timeColumn]) : null;
  const issues: RowQualityIssue[] = [];
  const invalidFields = new Set<string>();

  if (timestamp == null) {
    addIssue(issues, invalidFields, {
      code: 'missing_timestamp',
      field: timeColumn,
      message: timeColumn ? `时间列“${timeColumn}”为空或无法解析` : '未识别到时间列',
    });
  } else if (duplicateTimestamps.has(timestamp)) {
    addIssue(issues, invalidFields, {
      code: 'duplicate_timestamp',
      field: timeColumn,
      message: '采样时间重复',
    });
  }

  for (const mapping of mappings) {
    const raw = String(row[mapping.sourceColumn] ?? '').trim();
    if (raw === '') {
      addIssue(issues, invalidFields, {
        code: 'missing_field',
        field: mapping.sourceColumn,
        message: `字段“${mapping.sourceColumn}”缺失`,
      });
      continue;
    }
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
      addIssue(issues, invalidFields, {
        code: 'invalid_number',
        field: mapping.sourceColumn,
        message: `字段“${mapping.sourceColumn}”不是有效数值`,
      });
      continue;
    }
    // 热工表 T0~T5 中出现 150V 以上电压级数值，是当前导出缺列后左移的强信号。
    // 只隔离并报告，不尝试把后续单元格猜回其它列。
    if (
      profile.kind === 'thermal-electrical' &&
      TEMPERATURE_KEYS.has(mapping.fieldKey) &&
      Math.abs(value) >= 150
    ) {
      addIssue(issues, invalidFields, {
        code: 'temperature_voltage_misalignment',
        field: mapping.sourceColumn,
        message: `温度通道出现电压级数值 ${value}，疑似列结构错位`,
      });
    }
  }

  // 热工/电表表任一已识别通道缺失或发生强错位时，整行不可用于联合注入；
  // invalidFields 仍保留字段级原因，原始行也不删除。
  const rowFatal = timestamp == null || issues.some((issue) =>
    issue.code === 'duplicate_timestamp' ||
    issue.code === 'temperature_voltage_misalignment' ||
    (profile.kind === 'thermal-electrical' && issue.code === 'missing_field'),
  );
  return {
    rowIndex,
    raw: row,
    timestamp,
    valid: !rowFatal,
    invalidFields: [...invalidFields],
    issues,
  };
}

/**
 * 把解析后的文件整理为可持久化的数据源描述。
 * 该函数只增加元数据，不重采样、不填值，也不修改原始行。
 */
export function prepareDataSource(input: PrepareDataSourceInput): PreparedDataSource {
  const headers = [...input.headers];
  const rows = input.rows.map((row) => ({ ...row }));
  const profile = detectSourceProfile(headers);
  const fieldMappings = buildFieldMappings(headers);
  const timeColumn = input.timeColumn ?? detectTimeColumn(headers, rows);
  const timeStats = buildTimeStats(rows, timeColumn);

  const timestampCounts = new Map<number, number>();
  for (const row of rows) {
    const timestamp = timeColumn ? parseDatasetTime(row[timeColumn]) : null;
    if (timestamp != null) timestampCounts.set(timestamp, (timestampCounts.get(timestamp) ?? 0) + 1);
  }
  const duplicateTimestamps = new Set(
    [...timestampCounts.entries()].filter(([, count]) => count > 1).map(([timestamp]) => timestamp),
  );
  const processedRows = rows.map((row, rowIndex) =>
    inspectRow(row, rowIndex, timeColumn, fieldMappings, profile, duplicateTimestamps),
  );
  const issueCounts: SourceQualityReport['issueCounts'] = {};
  for (const row of processedRows) {
    for (const issue of row.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  }
  const invalidRows = processedRows.filter((row) => !row.valid).length;
  const invalidFieldCount = processedRows.reduce((sum, row) => sum + row.invalidFields.length, 0);

  return {
    id: input.id,
    filename: input.filename,
    format: input.format,
    headers,
    rows,
    profile,
    fieldMappings,
    timeStats,
    quality: {
      totalRows: rows.length,
      validRows: rows.length - invalidRows,
      invalidRows,
      invalidFieldCount,
      issueCounts,
    },
    processedRows,
  };
}
