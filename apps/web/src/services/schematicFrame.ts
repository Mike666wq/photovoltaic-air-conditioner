import { toSchematicBatteryPowerKw } from './batteryConvention';
import { DEFAULT_BATTERY_CURRENT_CONVENTION, type BatteryCurrentConvention } from '../store/analysis';
import type { NumericFieldKey } from './dataMapper';
import type { PlaybackFrame } from './playbackSession';
import type {
  AtMode,
  PlaybackSnapshot,
  PlaybackStatusKey,
  SimulationState,
} from '../store/simulation';

export interface SchematicFrameResult {
  snapshot: PlaybackSnapshot;
  measurements: Partial<Record<NumericFieldKey, number>>;
  measurementAvailability: Partial<Record<NumericFieldKey, boolean>>;
  statuses: SchematicStatuses;
}

export type SchematicStatuses = Partial<Pick<SimulationState,
  'pv_on' | 'cb_connected' | 'gs_on' | 'grid_online' | 'hp_on' | 'pump_on' | 'load_on' | 'at_mode'
>>;

const MEASUREMENT_FIELDS: NumericFieldKey[] = [
  'pv_power', 'pv_sun', 'bat_soc', 'hp_temp', 'hp_power', 'tank_temp',
  'tank_volume', 'tank_flow', 'pump_flow', 'at_temp', 'at_fan_speed',
  'pcm_temp', 'load_power_kw', 'battery_power_kw', 'pl_flow', 'rl_flow', 'wl_flow',
];

/**
 * canonical 数据 → 原理图兼容字段。
 * T0/T1、T4/T5 等原始独立通道始终保留在 snapshot.values；只有确有明确
 * 原理图含义的字段才桥接到旧的 NumericFieldKey，避免再次发生后列覆盖前列。
 */
export function buildSchematicFrame(
  frame: PlaybackFrame,
  state: Pick<SimulationState, 'pcm_temp_select'>,
  batteryConvention: BatteryCurrentConvention = DEFAULT_BATTERY_CURRENT_CONVENTION,
): SchematicFrameResult {
  const values = frame.values;
  const measurements: Partial<Record<NumericFieldKey, number>> = {};
  const measurementAvailability: Partial<Record<NumericFieldKey, boolean>> = {};
  const put = (field: NumericFieldKey, value: number | undefined) => {
    if (value == null || !Number.isFinite(value)) return;
    measurements[field] = value;
    measurementAvailability[field] = true;
  };

  put('pv_power', values.pv_power);
  put('bat_soc', values.battery_soc);
  put('hp_power', values.hp_power);
  // T2 是出风温度，应驱动末端而不是冒充热泵内部温度。
  put('at_temp', values.outlet_temp);
  put('at_fan_speed', values.fan_speed);
  put('load_power_kw', values.system_active_power);
  put('pcm_temp', state.pcm_temp_select === 'T1' ? values.pcm_temp_2 : values.pcm_temp_1);
  if (values.water_flow != null) {
    put('tank_flow', values.water_flow);
    put('pump_flow', values.water_flow);
  }
  if (values.battery_voltage != null && values.battery_current != null) {
    // 符号换算统一走 batteryConvention：用户口径 → 原理图内部口径（正=放电）。
    // 原先此处硬编码 -(V*I)/1000，等于假定用户口径恒为 positive-charge；
    // 用户在大屏切换「BMS 电流方向」后，这里不会跟随。
    put('battery_power_kw', toSchematicBatteryPowerKw(
      values.battery_voltage, values.battery_current, batteryConvention,
    ) ?? undefined);
  }

  for (const field of MEASUREMENT_FIELDS) {
    if (measurementAvailability[field] !== true) measurementAvailability[field] = false;
  }

  const statuses: SchematicStatuses = {};
  const statusAvailability: PlaybackSnapshot['statusAvailability'] = {};
  const statusValues: PlaybackSnapshot['statuses'] = {};
  const setStatus = (key: PlaybackStatusKey, value: boolean | AtMode) => {
    (statuses as Record<string, boolean | AtMode>)[key] = value;
    statusValues[key] = value;
    statusAvailability[key] = true;
  };
  const unavailableStatus = (key: PlaybackStatusKey) => {
    statusValues[key] = 'unknown';
    statusAvailability[key] = false;
  };

  if (values.pv_power != null || values.pv_voltage != null || values.pv_current != null) {
    const power = values.pv_power ?? ((values.pv_voltage ?? 0) * (values.pv_current ?? 0) / 1000);
    setStatus('pv_on', Math.abs(power) > 0.01);
  } else unavailableStatus('pv_on');
  if (values.grid_voltage != null) setStatus('grid_online', Math.abs(values.grid_voltage) >= 50);
  else unavailableStatus('grid_online');
  if (values.system_active_power != null) setStatus('load_on', Math.abs(values.system_active_power) > 0.01);
  else unavailableStatus('load_on');
  if (values.hp_power != null) setStatus('hp_on', Math.abs(values.hp_power) > 0.01);
  else unavailableStatus('hp_on');
  if (values.water_flow != null) setStatus('pump_on', Math.abs(values.water_flow) > 0.01);
  else unavailableStatus('pump_on');
  if (values.outlet_temp != null && values.ambient_temp != null) {
    const delta = values.outlet_temp - values.ambient_temp;
    setStatus('at_mode', delta < -0.5 ? 'cool' : delta > 0.5 ? 'heat' : 'off');
  } else unavailableStatus('at_mode');
  unavailableStatus('cb_connected');
  unavailableStatus('gs_on');

  const provenance = Object.fromEntries(Object.entries(frame.provenance).map(([field, item]) => [
    field,
    { sourceId: item.sourceId, column: item.sourceColumn },
  ]));
  return {
    measurements,
    measurementAvailability,
    statuses,
    snapshot: {
      timestamp: frame.timestamp,
      values: { ...values },
      availability: Object.fromEntries(Object.keys(values).map((key) => [key, true])),
      provenance,
      statuses: statusValues,
      statusAvailability,
      sourceIds: Object.keys(frame.samples),
      sourceRowIndices: Object.fromEntries(Object.entries(frame.samples).map(([sourceId, sample]) => [sourceId, sample.rowIndex])),
      sourceTimestamps: Object.fromEntries(Object.entries(frame.samples).map(([sourceId, sample]) => [sourceId, sample.timestamp])),
    },
  };
}
