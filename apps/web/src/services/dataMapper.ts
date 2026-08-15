import type { SimulationState } from '../store/simulation';
import { findPdfColumnMapping } from './pdfFieldMap';

/**
 * 仅数值字段（CSV 注入只能写数值；boolean/string/complex 字段不在导入范围）
 * 与 store/simulation.ts 的 SimulationState 字段对齐
 */
export type NumericFieldKey =
  | 'pv_power'
  | 'pv_sun'
  | 'bat_soc'
  | 'hp_temp'
  | 'hp_power'
  | 'tank_temp'
  | 'tank_volume'
  | 'tank_flow'
  | 'pump_flow'
  | 'at_temp'
  | 'at_fan_speed'
  | 'pcm_temp'
  | 'load_power_kw'
  | 'battery_power_kw'
  | 'pl_flow'
  | 'rl_flow'
  | 'wl_flow';

export const FIELD_OPTIONS: Array<{ value: NumericFieldKey; label: string }> = [
  { value: 'pv_power', label: 'PV 功率 (kW)' },
  { value: 'pv_sun', label: '阳光强度 (0-1)' },
  { value: 'bat_soc', label: 'SOC (%)' },
  { value: 'hp_temp', label: 'HP 温度 (℃)' },
  { value: 'hp_power', label: 'HP 功率 (kW)' },
  { value: 'tank_temp', label: '水箱温度 (℃)' },
  { value: 'tank_volume', label: '水箱水量 (%)' },
  { value: 'tank_flow', label: '水箱流量 (m³/h)' },
  { value: 'pump_flow', label: '水泵流量 (m³/h)' },
  { value: 'at_temp', label: '末端温度 (℃)' },
  { value: 'at_fan_speed', label: '风档 (0-4)' },
  { value: 'pcm_temp', label: 'PCM 温度 (℃)' },
  { value: 'load_power_kw', label: '负载功率 (kW)' },
  { value: 'battery_power_kw', label: '电池功率 (kW)' },
  { value: 'pl_flow', label: '电力线流量' },
  { value: 'rl_flow', label: '制冷剂量' },
  { value: 'wl_flow', label: '水线流速' },
];

const NORM_RE = /[\s_\-()（）℃³]+/g;

/**
 * 每个部件允许被实验数据导入的字段白名单（基于 PDF 字段对照表 M2 阶段落实）。
 * - 仅列入能直接通过 NumericalFieldKey 写入 store 的数值字段
 * - 灰色（空数组）部件暂无可导入数据源
 * - 'grid' 已标记：grid_online 是 boolean，不在 NumericalFieldKey 范围
 */
export const componentImportableFields: Record<string, NumericFieldKey[]> = {
  'pv-array':       ['pv_power', 'pv_sun'],
  'battery':        ['bat_soc', 'battery_power_kw'],
  'heat-pump':      ['hp_temp', 'hp_power'],
  'tank':           ['tank_temp', 'tank_volume', 'tank_flow'],
  'pump':           ['pump_flow'],
  'grid':           [],  // grid_online 是 boolean，M2 阶段单独处理
  // 其它 8 部件：
  'combiner-box':   [],
  'grid-switch':    [],
  'inverter':       [],
  'load':           [],
  'pcm':            [],
  'air-terminal':   [],
  'power-meter':    [],
  'temp-sensor':    [],
};

/** 部件是否有任何可导入字段（含老 fallback：返回信息） */
export function getImportableFields(compId: string | null | undefined): NumericFieldKey[] {
  if (!compId) return [];
  return componentImportableFields[compId] ?? [];
}

/**
 * 当前部件可用的字段选项（用于 ImportDataDialog 列映射下拉）。
 * 空数组 → 该部件暂无可导入字段。
 */
export function getFieldOptionsForComponent(
  compId: string | null | undefined,
): NumericFieldKey[] {
  return getImportableFields(compId);
}

/**
 * 智能匹配：列名 → 字段
 * - 完全相等（normalize 后）
 * - 字段名等于列名（如 "pv_power"）
 * - 子串包含（列名含字段 label，或反之）
 */
export function autoMapColumn(headerName: string): NumericFieldKey | null {
  const norm = headerName.toLowerCase().replace(NORM_RE, '');
  for (const opt of FIELD_OPTIONS) {
    const optNorm = opt.label.toLowerCase().replace(NORM_RE, '');
    const valueNorm = opt.value.toLowerCase();
    if (norm === optNorm || norm === valueNorm) {
      return opt.value;
    }
    if (norm.includes(optNorm) || optNorm.includes(norm)) {
      return opt.value;
    }
  }
  return null;
}

export function applyMapping(
  mapping: Record<string, NumericFieldKey>,
  rows: Array<Record<string, string>>,
  strategy: 'first' | 'last' | 'avg' = 'last',
): Partial<SimulationState> {
  const result: Partial<SimulationState> = {};
  for (const [col, field] of Object.entries(mapping)) {
    if (!field) continue;
    const values = rows
      .map((row) => parseFloat(row[col]))
      .filter((v) => !isNaN(v));
    if (values.length === 0) continue;
    let v: number;
    if (strategy === 'first') v = values[0];
    else if (strategy === 'last') v = values[values.length - 1];
    else v = values.reduce((a, b) => a + b, 0) / values.length;
    // 整数字段（风档）取整
    if (field === 'at_fan_speed') {
      v = Math.round(v);
    }
    (result as Record<string, number>)[field] = v;
  }
  return result;
}
const ALIASES: Record<string, NumericFieldKey> = {
  'soc': 'bat_soc',
  'socpercent': 'bat_soc',
  '荷电状态': 'bat_soc',
  '剩余电量': 'bat_soc',
  'pvpower': 'pv_power',
  '光伏功率': 'pv_power',
  '发电功率': 'pv_power',
  'output': 'pv_power',
  'hppower': 'hp_power',
  '热泵功率': 'hp_power',
  '制热功率': 'hp_power',
  'loadpower': 'load_power_kw',
  'load': 'load_power_kw',
  '负载': 'load_power_kw',
  '负载功率': 'load_power_kw',
  '用电': 'load_power_kw',
  'consumption': 'load_power_kw',
  'batterypower': 'battery_power_kw',
  '电池功率': 'battery_power_kw',
  'cellpower': 'battery_power_kw',
  'tanktemp': 'tank_temp',
  'temptanktemp': 'tank_temp',
  '水箱温度': 'tank_temp',
  '水温': 'tank_temp',
  'water温度': 'tank_temp',
  'attemp': 'at_temp',
  'airtemp': 'at_temp',
  '末端温度': 'at_temp',
  // M2-β 移除环境温度类别名（at_temp = 末端设定温度，环境温度不应进它）：
  // 室温/roomtemp/indoortemp/ambienttemp/environmentaltemp 已删，环境温度走 TS-env 直读。
  'hptemp': 'hp_temp',
  '热泵温度': 'hp_temp',
  'outlettemp': 'hp_temp',
  '出水温度': 'hp_temp',
  'pcmtemp': 'pcm_temp',
  '相变温度': 'pcm_temp',
  '相变材料温度': 'pcm_temp',
  'tankvolume': 'tank_volume',
  '水箱水量': 'tank_volume',
  'tanklevel': 'tank_volume',
  'waterlevel': 'tank_volume',
  'tankflow': 'tank_flow',
  '水箱流量': 'tank_flow',
  'waterflow': 'tank_flow',
  'pumpflow': 'pump_flow',
  'pump': 'pump_flow',
  '水泵流量': 'pump_flow',
  '循环水流量': 'pump_flow',
  'pvsun': 'pv_sun',
  'sun': 'pv_sun',
  'sunlight': 'pv_sun',
  'irradiance': 'pv_sun',
  '阳光': 'pv_sun',
  '辐照度': 'pv_sun',
  '光照': 'pv_sun',
  'atfanspeed': 'at_fan_speed',
  'fanspeed': 'at_fan_speed',
  '风档': 'at_fan_speed',
  '风速': 'at_fan_speed',
};

export function matchColumnToField(headerName: string): NumericFieldKey | null {
  // 优先匹配 PDF 字段对照表（T0.PV / D3.PV / ZU6682.PV 等）
  // 这样 PDF 文件的精确列名一定命中目标字段，不会被模糊别名抢先
  const pdfMapping = findPdfColumnMapping(headerName);
  if (pdfMapping && pdfMapping.targetField) {
    return pdfMapping.targetField;
  }
  const auto = autoMapColumn(headerName);
  if (auto) return auto;
  const norm = headerName.toLowerCase().replace(/[\s_\-()（）℃³]+/g, '');
  if (ALIASES[norm]) return ALIASES[norm];
  for (const [alias, field] of Object.entries(ALIASES)) {
    if (norm.includes(alias) || alias.includes(norm)) return field;
  }
  return null;
}
