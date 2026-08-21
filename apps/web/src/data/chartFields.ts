/**
 * M3 图表字段字典。
 *
 * 权威来源：data/字段对照表.jpg。原理图的 pdfFieldMap/dataMapper 是此表的
 * 已实现子集；图表直接保留每个原始通道，避免 T4/T5、T0/T1 被写入同一 store
 * 字段后丢失独立曲线。
 */
export type ChartSemantic = 'instant' | 'cumulative' | 'state' | 'setpoint';

export interface ChartFieldDef {
  key: string;
  label: string;
  unit: string;
  semantic: ChartSemantic;
  aliases: string[];
  color: string;
  description?: string;
}

const pdfAliases = (code: string) => [code, `${code}.PV`, `${code}_PV`];

export const CHART_FIELDS: ChartFieldDef[] = [
  { key: 'pcm_temp_1', label: '相变温度1', unit: '℃', semantic: 'instant', aliases: pdfAliases('T0'), color: '#a78bfa' },
  { key: 'pcm_temp_2', label: '相变温度2', unit: '℃', semantic: 'instant', aliases: pdfAliases('T1'), color: '#c4b5fd' },
  { key: 'outlet_temp', label: '出风温度', unit: '℃', semantic: 'instant', aliases: [...pdfAliases('T2'), '出风温度', 'outlet_temp'], color: '#a855f7' },
  { key: 'ambient_temp', label: '环境温度（工艺）', unit: '℃', semantic: 'instant', aliases: pdfAliases('T3'), color: '#94a3b8' },
  { key: 'supply_water_temp', label: '送水温度', unit: '℃', semantic: 'instant', aliases: [...pdfAliases('T4'), '送水温度'], color: '#3b82f6' },
  { key: 'return_water_temp', label: '回水温度', unit: '℃', semantic: 'instant', aliases: [...pdfAliases('T5'), '回水温度'], color: '#f97316' },
  { key: 'tank_temp', label: '水箱温度', unit: '℃', semantic: 'instant', aliases: ['水箱温度', 'tank_temp', '水温'], color: '#ec4899' },
  { key: 'system_voltage', label: '系统电压', unit: 'V', semantic: 'instant', aliases: pdfAliases('D1'), color: '#8b5cf6' },
  { key: 'system_current', label: '系统电流', unit: 'A', semantic: 'instant', aliases: pdfAliases('D2'), color: '#f43f5e' },
  { key: 'system_active_power', label: '系统有功功率', unit: 'kW', semantic: 'instant', aliases: [...pdfAliases('D3'), 'load_power_kw', '负载功率', '用电'], color: '#a78bfa' },
  { key: 'system_reactive_power', label: '系统无功功率', unit: 'kVar', semantic: 'instant', aliases: pdfAliases('D4'), color: '#f97316' },
  { key: 'system_apparent_power', label: '系统视在功率', unit: 'kVA', semantic: 'instant', aliases: pdfAliases('D5'), color: '#60a5fa' },
  { key: 'system_power_factor', label: '系统总功率因数', unit: '', semantic: 'instant', aliases: pdfAliases('D6'), color: '#e879f9' },
  { key: 'system_frequency', label: '系统电网频率', unit: 'Hz', semantic: 'instant', aliases: pdfAliases('D7'), color: '#38bdf8' },
  { key: 'system_energy', label: '系统有功总电能', unit: 'kWh', semantic: 'cumulative', aliases: pdfAliases('D8'), color: '#a78bfa' },
  { key: 'grid_voltage', label: '市电电压', unit: 'V', semantic: 'instant', aliases: pdfAliases('DU1'), color: '#06b6d4' },
  { key: 'grid_current', label: '市电电流', unit: 'A', semantic: 'instant', aliases: pdfAliases('DU2'), color: '#fb923c' },
  { key: 'grid_active_power', label: '市电有功功率', unit: 'kW', semantic: 'instant', aliases: pdfAliases('DU3'), color: '#0ea5e9' },
  { key: 'grid_power_factor', label: '市电总功率因数', unit: '', semantic: 'instant', aliases: pdfAliases('DU6'), color: '#67e8f9' },
  { key: 'grid_frequency', label: '市电电网频率', unit: 'Hz', semantic: 'instant', aliases: pdfAliases('DU7'), color: '#7dd3fc' },
  { key: 'grid_energy', label: '市电总电能', unit: 'kWh', semantic: 'cumulative', aliases: pdfAliases('DU8'), color: '#0284c7' },
  { key: 'pv_voltage', label: '光伏直流电压', unit: 'V', semantic: 'instant', aliases: [...pdfAliases('ZU6682'), '光伏电压', '直流电压'], color: '#38bdf8' },
  { key: 'pv_current', label: '光伏直流电流', unit: 'A', semantic: 'instant', aliases: [...pdfAliases('ZI6682'), '光伏电流', '直流电流'], color: '#f59e0b' },
  { key: 'pv_power', label: '光伏功率', unit: 'kW', semantic: 'instant', aliases: [...pdfAliases('ZW66822'), 'ZVW66822.PV', 'ZVW66822_PV', 'pv_power', '光伏功率', '发电功率'], color: '#facc15' },
  { key: 'battery_voltage', label: '电池电压', unit: 'V', semantic: 'instant', aliases: ['电压(V)', '电池电压', 'battery_voltage'], color: '#a78bfa' },
  { key: 'battery_current', label: '电池电流', unit: 'A', semantic: 'instant', aliases: ['电流(A)', '电池电流', 'battery_current'], color: '#f59e0b' },
  { key: 'battery_soc', label: '电池 SOC', unit: '%', semantic: 'instant', aliases: ['SOC(%)', 'SOC', 'soc', '荷电状态'], color: '#22c55e' },
  { key: 'battery_remaining_ah', label: '电池剩余容量', unit: 'Ah', semantic: 'instant', aliases: ['剩余容量(Ah)', '剩余容量'], color: '#86efac' },
  { key: 'battery_full_capacity_ah', label: '电池满充容量', unit: 'Ah', semantic: 'state', aliases: ['满充容量(Ah)', '满充容量'], color: '#bbf7d0' },
  { key: 'battery_ambient_temp', label: '电池环境温度', unit: '℃', semantic: 'instant', aliases: ['环境温度'], color: '#94a3b8' },
  { key: 'hp_power', label: '热泵功率', unit: 'kW', semantic: 'instant', aliases: ['hp_power', '热泵功率', '制热功率'], color: '#fb923c' },
  { key: 'water_flow', label: '循环水流量', unit: 'm³/h', semantic: 'instant', aliases: ['tank_flow', 'pump_flow', '水箱流量', '水泵流量', '循环水流量'], color: '#60a5fa' },
  { key: 'fan_speed', label: '送风风机速度', unit: '', semantic: 'setpoint', aliases: pdfAliases('D2000'), color: '#22d3ee' },
  { key: 'cooling_feedback', label: '冷量反馈', unit: '', semantic: 'instant', aliases: pdfAliases('D2212'), color: '#f97316' },
];

export const CHART_FIELD_BY_KEY = Object.fromEntries(CHART_FIELDS.map((field) => [field.key, field]));

export function normalizeChartHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[._\-\s()（）]/g, '');
}

export function findChartField(key: string): ChartFieldDef | undefined {
  return CHART_FIELD_BY_KEY[key];
}

export function readChartNumber(row: Record<string, string>, fieldKey: string): number | null {
  const field = findChartField(fieldKey);
  if (!field) return null;
  const aliases = new Set(field.aliases.map(normalizeChartHeader));
  for (const [header, raw] of Object.entries(row)) {
    if (!aliases.has(normalizeChartHeader(header))) continue;
    const value = Number.parseFloat(String(raw).trim());
    if (Number.isFinite(value)) return value;
  }
  return null;
}
