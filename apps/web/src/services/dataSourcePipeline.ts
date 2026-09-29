import { CHART_FIELDS, normalizeChartHeader } from '../data/chartFields';
import { detectSourceProfile, type SourceProfile } from '../data/sourceProfile';
import { matchColumnToField, type NumericFieldKey } from './dataMapper';
import { detectTimeColumn, parseDatasetTime } from './dataset';

export type SourceFormat = 'csv' | 'xlsx' | 'pdf';

export interface SourceFieldMapping {
  sourceColumn: string;
  fieldKey: string;
  confidence: 'exact-alias' | 'fuzzy-alias';
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
  | 'temperature_voltage_misalignment'
  | 'value_out_of_range';

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

/**
 * 按物理单位的「绝不可能」硬上限。
 *
 * 背景：力控导出会出现整行列左移，某个通道收到另一个通道的值。
 * 原实现只保护温度通道（|v| >= 150），于是 220.4 落到功率列、215.6 落到电流列时
 * 无人拦截，会凭空编出光伏/系统发电量。电压列是唯一不能设上限的——
 * 220V / 380V / 直流母线 1000V 都是合法读数。
 *
 * 上限取「本项目额定值的 20 倍」量级：真实运行数据（几 kW、几十 A）永不触发，
 * 而电压级错位（110 / 220 / 380 / 1569）必然触发。
 */
const UNIT_ABS_LIMITS: Record<string, number> = {
  kW: 200,      // 逆变器额定 10 kW
  kVar: 200,
  kVA: 200,
  A: 500,       // 直流/交流额定 32A / 100A
  'm³/h': 2000,
  '℃': 150,     // 与历史阈值一致
  C: 150,       // 环境温度字段的无单位写法
};

function readUnitLimit(fieldKey: string): { limit: number; unit: string } | null {
  const field = CHART_FIELDS.find((candidate) => candidate.key === fieldKey);
  if (!field) return null;
  // 累计量（kWh 等）无幅值上限语义，跳过；setpoint 类同理
  if (field.semantic === 'cumulative' || field.semantic === 'setpoint') return null;
  const unit = field.unit.trim();
  const limit = UNIT_ABS_LIMITS[unit];
  return limit === undefined ? null : { limit, unit: unit || String(fieldKey) };
}

const TEMPERATURE_KEYS = new Set([
  'pcm_temp_1',
  'pcm_temp_2',
  'outlet_temp',
  'ambient_temp',
  'supply_water_temp',
  'return_water_temp',
]);

const NUMERIC_FIELD_TO_CHART_FIELD: Partial<Record<NumericFieldKey, string>> = {
  pv_power: 'pv_power',
  bat_soc: 'battery_soc',
  hp_power: 'hp_power',
  tank_temp: 'tank_temp',
  load_power_kw: 'system_active_power',
  tank_flow: 'water_flow',
  pump_flow: 'water_flow',
  at_fan_speed: 'fan_speed',
  pcm_temp: 'pcm_temp_1',
};

function buildFieldMappings(headers: string[]): SourceFieldMapping[] {
  const result: SourceFieldMapping[] = [];
  const mappedColumns = new Set<string>();
  const mappedFields = new Set<string>();

  // 先走大屏字段字典的精确别名，保证 T0/T1、D/DU 与 BMS 通道不会被模糊规则抢占。
  for (const header of headers) {
    const normalizedHeader = normalizeChartHeader(header);
    const field = CHART_FIELDS.find((candidate) =>
      candidate.aliases.some((alias) => normalizeChartHeader(alias) === normalizedHeader),
    );
    if (field && !mappedFields.has(field.key)) {
      result.push({ sourceColumn: header, fieldKey: field.key, confidence: 'exact-alias' });
      mappedColumns.add(header);
      mappedFields.add(field.key);
    }
  }

  // 再复用原理图的数据映射规则兜底，并桥接到同一套大屏规范字段。
  // 一个规范字段只接受一个来源列，避免多个模糊列在回放时相互覆盖。
  for (const header of headers) {
    if (mappedColumns.has(header)) continue;
    const numericField = matchColumnToField(header);
    const chartField = numericField ? NUMERIC_FIELD_TO_CHART_FIELD[numericField] : undefined;
    if (!chartField || mappedFields.has(chartField)) continue;
    result.push({ sourceColumn: header, fieldKey: chartField, confidence: 'fuzzy-alias' });
    mappedFields.add(chartField);
  }
  return result;
}

/** 导入确认前的硬门禁：无时间、无业务字段或无有效行的数据不能进入回放。 */
export function collectPlaybackImportBlockers(
  sources: PreparedDataSource[],
  strictFrameCount: number,
  toleranceMs = 2_000,
): string[] {
  if (!sources.length) return ['尚未选择可用的数据文件'];
  const blockers: string[] = [];
  for (const source of sources) {
    if (!source.timeStats.timeColumn || source.timeStats.validTimestampCount === 0) {
      blockers.push(`${source.filename}：未识别到有效时间列`);
    }
    if (!source.fieldMappings.length) {
      blockers.push(`${source.filename}：未识别到可回放的业务字段`);
    }
    if (source.quality.validRows === 0) {
      blockers.push(`${source.filename}：没有通过质量检查的有效行`);
    }
  }
  if (sources.length > 1 && strictFrameCount === 0) {
    blockers.push(`所选数据源在 ±${toleranceMs / 1_000} 秒条件下没有严格同步交集帧`);
  }
  return blockers;
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
  timestamps: Array<number | null>,
  timeColumn: string | undefined,
): SourceTimeStats {
  const valid = timestamps.filter((value): value is number => value != null).sort((a, b) => a - b);
  const unique = [...new Set(valid)];
  const intervals = unique.slice(1).map((value, index) => value - unique[index]).filter((value) => value > 0);
  const medianIntervalMs = median(intervals);
  return {
    timeColumn,
    start: valid[0] ?? null,
    end: valid.length ? valid[valid.length - 1] : null,
    validTimestampCount: valid.length,
    invalidTimestampCount: timestamps.length - valid.length,
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
  timestamp: number | null,
  timeColumn: string | undefined,
  mappings: SourceFieldMapping[],
  profile: SourceProfile,
  duplicateTimestamps: ReadonlySet<number>,
): ProcessedSourceRow {
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
      continue;
    }

    // 其余通道：按物理单位做量程兜底，拦截"电压值落到功率/电流列"这类列左移。
    const unitLimit = readUnitLimit(mapping.fieldKey);
    if (unitLimit && Math.abs(value) > unitLimit.limit) {
      addIssue(issues, invalidFields, {
        code: 'value_out_of_range',
        field: mapping.sourceColumn,
        message: `${mapping.fieldKey} 出现 ${value}${unitLimit.unit}，超出合理量程 ±${unitLimit.limit}${unitLimit.unit}，疑似列结构错位`,
      });
    }
  }

  // 热工/电导表任一已识别通道缺失或发生强错位（温度电压错位 / 量纲越界）时，整行不可用于联合注入；
  // invalidFields 仍保留字段级原因，原始行也不删除。
  const rowFatal = timestamp == null || issues.some((issue) =>
    issue.code === 'duplicate_timestamp' ||
    issue.code === 'temperature_voltage_misalignment' ||
    issue.code === 'value_out_of_range' ||
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
  // 调用方交给整理层后按只读数据源使用。保留同一组原始行引用，避免 18k×36
  // 的 BMS 表在解析完成后立刻再复制一整份；质量报告也只引用而不改写原行。
  const rows = input.rows;
  const profile = detectSourceProfile(headers);
  const fieldMappings = buildFieldMappings(headers);
  const timeColumn = input.timeColumn ?? detectTimeColumn(headers, rows);
  // 时间戳是大文件质量检测的热点。一次解析结果同时复用于时间统计、
  // 重复时间检查和逐行报告，避免 BMS 万级数据被重复解析三遍。
  const timestamps = rows.map((row) => timeColumn ? parseDatasetTime(row[timeColumn]) : null);
  const timeStats = buildTimeStats(timestamps, timeColumn);

  const timestampCounts = new Map<number, number>();
  for (const timestamp of timestamps) {
    if (timestamp != null) timestampCounts.set(timestamp, (timestampCounts.get(timestamp) ?? 0) + 1);
  }
  const duplicateTimestamps = new Set(
    [...timestampCounts.entries()].filter(([, count]) => count > 1).map(([timestamp]) => timestamp),
  );
  const processedRows = rows.map((row, rowIndex) =>
    inspectRow(row, rowIndex, timestamps[rowIndex], timeColumn, fieldMappings, profile, duplicateTimestamps),
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
