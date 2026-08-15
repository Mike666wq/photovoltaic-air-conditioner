import type { NumericFieldKey } from './dataMapper';
import type { MeterBind } from '../data/meters';

/**
 * PDF 字段对照表。权威字段来源为 data/字段对照表.jpg。
 * 当前 PDF 通常导出 17 个业务数据列（另有序号、采样时刻元数据），但 IO 点表
 * 还定义 D4/D5/D7/D8、DU7/DU8 以及控制状态点；这里完整保留其识别能力。
 *
 * 命名规则：
 *   - PDF 原始列名 `xxx.PV` 在解析后会规范化为 `xxx_PV`（详见 injectionParser.ts）
 *   - 本表存 PDF 原始列名（含点），匹配时用 normalizePdfHeader() 做归一化比对
 */
export interface PdfColumnMapping {
  /** PDF 原始表头（含 ".PV"，如 "T0.PV"） */
  pdfHeader: string;
  /** 中文标签（来自 字段对照表.jpg） */
  chineseLabel: string;
  /** 目标 store 字段；电压/电流等仅仪表绑定字段用 null */
  targetField: NumericFieldKey | null;
  /** 该列对应的仪表绑定（功率检测器 / 温度检测器 / PCM 双温度） */
  meterBind: MeterBind | 'pcm-t0' | 'pcm-t1' | null;
  /** 数据来源设备 */
  device: 'PLC' | 'DS666H' | 'DDSU66' | 'DJSF668';
}

export const PDF_COLUMN_MAP: PdfColumnMapping[] = [
  // === PLC 温度（6 列）===
  { pdfHeader: 'T0.PV',       chineseLabel: '相变温度 1（PCM 表面）',  targetField: 'pcm_temp',  meterBind: 'pcm-t0', device: 'PLC' },
  { pdfHeader: 'T1.PV',       chineseLabel: '相变温度 2（PCM 内部）',  targetField: 'pcm_temp',  meterBind: 'pcm-t1', device: 'PLC' },
  { pdfHeader: 'T2.PV',       chineseLabel: '出风温度（热泵）',       targetField: 'hp_temp',   meterBind: 'outlet-temp', device: 'PLC' },
  { pdfHeader: 'T3.PV',       chineseLabel: '环境温度',              targetField: null,        meterBind: 'env-temp', device: 'PLC' },
  { pdfHeader: 'T4.PV',       chineseLabel: '送水温度',              targetField: 'tank_temp', meterBind: 'supply-temp', device: 'PLC' },
  { pdfHeader: 'T5.PV',       chineseLabel: '回水温度',              targetField: 'tank_temp', meterBind: 'return-temp', device: 'PLC' },
  // === DS666H / PLC 电表（完整 IO 点）===
  { pdfHeader: 'D1.PV',       chineseLabel: '电表电压',              targetField: null,        meterBind: 'meter-d',   device: 'DS666H' },
  { pdfHeader: 'D2.PV',       chineseLabel: '电表电流',              targetField: null,        meterBind: 'meter-d',   device: 'DS666H' },
  { pdfHeader: 'D3.PV',       chineseLabel: '瞬时有功功率',          targetField: 'load_power_kw', meterBind: 'meter-d', device: 'DS666H' },
  { pdfHeader: 'D4.PV',       chineseLabel: '瞬时无功功率',          targetField: null,        meterBind: null,        device: 'PLC' },
  { pdfHeader: 'D5.PV',       chineseLabel: '瞬时视在功率',          targetField: null,        meterBind: null,        device: 'PLC' },
  { pdfHeader: 'D6.PV',       chineseLabel: '瞬时总功率因数',        targetField: null,        meterBind: 'meter-d',   device: 'DS666H' },
  { pdfHeader: 'D7.PV',       chineseLabel: '电网频率',              targetField: null,        meterBind: null,        device: 'PLC' },
  { pdfHeader: 'D8.PV',       chineseLabel: '有功总电能',            targetField: null,        meterBind: null,        device: 'PLC' },
  // === DDSU66 市电表（完整 IO 点）===
  { pdfHeader: 'DU1.PV',      chineseLabel: '市电电压',              targetField: null,        meterBind: 'meter-du',  device: 'DDSU66' },
  { pdfHeader: 'DU2.PV',      chineseLabel: '市电电流',              targetField: null,        meterBind: 'meter-du',  device: 'DDSU66' },
  { pdfHeader: 'DU3.PV',      chineseLabel: '市电瞬时有功功率',      targetField: null,        meterBind: 'meter-du',  device: 'DDSU66' },
  { pdfHeader: 'DU6.PV',      chineseLabel: '市电总功率因数',        targetField: null,        meterBind: 'meter-du',  device: 'DDSU66' },
  { pdfHeader: 'DU7.PV',      chineseLabel: '市电电网频率',          targetField: null,        meterBind: null,        device: 'DDSU66' },
  { pdfHeader: 'DU8.PV',      chineseLabel: '市电总电能',            targetField: null,        meterBind: null,        device: 'DDSU66' },
  // === DJSF668 直流（3 列，传感器离线，仅保留映射）===
  { pdfHeader: 'ZU6682.PV',   chineseLabel: '直流电压',              targetField: null,        meterBind: null,        device: 'DJSF668' },
  { pdfHeader: 'ZI6682.PV',   chineseLabel: '直流电流',              targetField: null,        meterBind: null,        device: 'DJSF668' },
  { pdfHeader: 'ZW66822.PV',  chineseLabel: '直流功率',              targetField: 'pv_power',  meterBind: null,        device: 'DJSF668' },
];

/** 电表绑定 → 仪表显示与图表扩展字段。D6/DU6 是功率因数，D8/DU8 是总电能。 */
export interface MeterBindColumns {
  voltage: string;
  current: string;
  power: string;
  powerFactor: string;
  reactivePower?: string;
  apparentPower?: string;
  frequency?: string;
  energy?: string;
}

export const METER_BIND_COLUMNS: Record<'meter-d' | 'meter-du', MeterBindColumns> = {
  'meter-d': {
    voltage: 'D1.PV', current: 'D2.PV', power: 'D3.PV', powerFactor: 'D6.PV',
    reactivePower: 'D4.PV', apparentPower: 'D5.PV', frequency: 'D7.PV', energy: 'D8.PV',
  },
  'meter-du': {
    voltage: 'DU1.PV', current: 'DU2.PV', power: 'DU3.PV', powerFactor: 'DU6.PV',
    frequency: 'DU7.PV', energy: 'DU8.PV',
  },
};

/** PCM 双温度 → PDF 列 */
export const PCM_COLUMNS: Record<'pcm-t0' | 'pcm-t1', string> = {
  'pcm-t0': 'T0.PV',
  'pcm-t1': 'T1.PV',
};

/**
 * 把各种形式的表头归一化为 `xxx_pv` 形式（lowercase + `.` → `_`）。
 * 同时修正 PDF 拼写错误 `ZVW66822` → `ZW66822`（大小写无关）。
 *  - `T0.PV`         → `t0_pv`
 *  - `ZU6682.PV`     → `zu6682_pv`
 *  - `ZU6682_PV`     → `zu6682_pv`
 *  - `ZVW66822.PV`   → `zw66822_pv`
 */
export function normalizePdfHeader(header: string): string {
  let h = header.trim();
  // 拼写错误：ZVW66822 → ZW66822（不区分大小写、不依赖 .PV 后缀）
  h = h.replace(/ZVW66822(?=\.|$)/i, 'ZW66822');
  return h.replace(/\./g, '_').toLowerCase();
}

/**
 * 在 PDF_COLUMN_MAP 里查找归一化后的表头。
 *   - 不区分大小写
 *   - `.` 与 `_` 等价
 *   - 自动修正 ZVW66822.PV → ZW66822.PV
 * 返回 null 表示未匹配（可能是其他格式的 PDF / 旧版表头）。
 */
export function findPdfColumnMapping(header: string): PdfColumnMapping | null {
  const target = normalizePdfHeader(header);
  for (const m of PDF_COLUMN_MAP) {
    if (normalizePdfHeader(m.pdfHeader) === target) {
      return m;
    }
  }
  return null;
}

/** 把任意表头归一化为 PDF 表头（用于 dataMapper.mapColumnToField 优先匹配） */
export function canonicalPdfHeader(header: string): string | null {
  const mapping = findPdfColumnMapping(header);
  return mapping ? mapping.pdfHeader : null;
}

/**
 * 从一行采集数据中取某 PDF 列的数值（容错解析：空串/非数值 → null）。
 * header 可为原始列名（"T3.PV"）或归一化列名（"T3_PV"）。
 */
export function readPdfNumericCell(
  row: Record<string, string>,
  pdfHeader: string,
): number | null {
  const candidates = [pdfHeader, normalizePdfHeader(pdfHeader), pdfHeader.replace('.', '_')];
  for (const key of candidates) {
    const v = row[key];
    if (v == null || String(v).trim() === '') continue;
    const n = parseFloat(String(v));
    if (!isNaN(n)) return n;
  }
  return null;
}
