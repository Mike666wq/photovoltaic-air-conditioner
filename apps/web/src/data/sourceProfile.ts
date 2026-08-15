import { CHART_FIELDS, normalizeChartHeader } from './chartFields';

export type SourceProfileKind = 'thermal-electrical' | 'battery-bms' | 'mixed' | 'generic';

export interface SourceProfile {
  kind: SourceProfileKind;
  label: string;
  capabilities: string[];
  fieldKeys: string[];
}

/** 根据实际可识别字段判断数据能力，不以 PDF/XLSX 文件扩展名决定用途。 */
export function detectSourceProfile(headers: string[]): SourceProfile {
  const normalized = new Set(headers.map(normalizeChartHeader));
  const fieldKeys = CHART_FIELDS.filter((field) => field.aliases.some((alias) => normalized.has(normalizeChartHeader(alias)))).map((field) => field.key);
  const has = (keys: string[]) => keys.some((key) => fieldKeys.includes(key));
  const thermal = has(['pcm_temp_1', 'pcm_temp_2', 'outlet_temp', 'ambient_temp', 'supply_water_temp', 'return_water_temp']);
  const electrical = has(['system_voltage', 'system_current', 'system_active_power', 'grid_voltage', 'grid_current', 'grid_active_power', 'pv_voltage', 'pv_current', 'pv_power']);
  const battery = has(['battery_voltage', 'battery_current', 'battery_soc', 'battery_remaining_ah']);
  const capabilities = [thermal && '热工温度', electrical && '电表/光伏', battery && '电池 BMS'].filter((value): value is string => Boolean(value));
  const kind: SourceProfileKind = thermal || electrical
    ? battery ? 'mixed' : 'thermal-electrical'
    : battery ? 'battery-bms' : 'generic';
  const label = kind === 'thermal-electrical' ? '热工/电表数据' : kind === 'battery-bms' ? '电池 BMS 数据' : kind === 'mixed' ? '混合采集数据' : '通用时序数据';
  return { kind, label, capabilities, fieldKeys };
}
