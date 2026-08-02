// 9 个预设场景 + 默认字段（来自 demo.html）
export interface PresetState {
  // 数值滑块
  pv_power: number;
  pv_sun: number;
  bat_soc: number;
  hp_temp: number;
  hp_power: number;
  tank_temp: number;
  tank_volume: number;
  tank_flow: number;
  pump_flow: number;
  at_temp: number;
  pcm_temp: number;
  at_fan_speed: number;
  load_power_kw: number;
  battery_power_kw: number;
  // 7 个可点击部件 flag（与 SimulationState 对齐）
  pv_on: boolean;
  cb_connected: boolean;
  gs_on: boolean;
  hp_on: boolean;
  pump_on: boolean;
  load_on: boolean;
  at_mode: 'cool' | 'heat' | 'off';
  // 电网在线状态（独立于 gs_on）
  grid_online: boolean;
}

export const PRESETS: Record<string, PresetState> = {
  daytime: {
    pv_power: 4.85, pv_sun: 0.85, bat_soc: 82,
    hp_temp: 24, hp_power: 3.5,
    tank_temp: 35, tank_volume: 70, tank_flow: 3.0,
    pump_flow: 3.0, at_temp: 24, pcm_temp: 32,
    at_fan_speed: 3, load_power_kw: 0.62, battery_power_kw: -0.5,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'cool', grid_online: true,
  },
  evening: {
    pv_power: 1.20, pv_sun: 0.25, bat_soc: 65,
    hp_temp: 25, hp_power: 3.0,
    tank_temp: 42, tank_volume: 60, tank_flow: 2.0,
    pump_flow: 2.0, at_temp: 25, pcm_temp: 35,
    at_fan_speed: 2, load_power_kw: 0.62, battery_power_kw: 0.3,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'cool', grid_online: true,
  },
  night: {
    pv_power: 0.00, pv_sun: 0.0, bat_soc: 45,
    hp_temp: 23, hp_power: 2.0,
    tank_temp: 45, tank_volume: 55, tank_flow: 1.5,
    pump_flow: 1.5, at_temp: 23, pcm_temp: 38,
    at_fan_speed: 0, load_power_kw: 0.4, battery_power_kw: 0.2,
    pv_on: false, cb_connected: true, gs_on: true,
    hp_on: false, pump_on: false, load_on: true,
    at_mode: 'off', grid_online: true,
  },
  cooling: {
    pv_power: 3.20, pv_sun: 0.6, bat_soc: 75,
    hp_temp: 22, hp_power: 5.0,
    tank_temp: 18, tank_volume: 80, tank_flow: 4.0,
    pump_flow: 4.0, at_temp: 22, pcm_temp: 22,
    at_fan_speed: 4, load_power_kw: 0.62, battery_power_kw: -0.8,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'cool', grid_online: true,
  },
  heating: {
    pv_power: 1.50, pv_sun: 0.3, bat_soc: 55,
    hp_temp: 26, hp_power: 4.5,
    tank_temp: 50, tank_volume: 65, tank_flow: 3.5,
    pump_flow: 3.5, at_temp: 26, pcm_temp: 28,
    at_fan_speed: 4, load_power_kw: 0.62, battery_power_kw: -0.6,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'heat', grid_online: true,
  },
  hotWater: {
    pv_power: 2.00, pv_sun: 0.5, bat_soc: 60,
    hp_temp: 28, hp_power: 4.0,
    tank_temp: 88, tank_volume: 90, tank_flow: 3.0,
    pump_flow: 3.0, at_temp: 24, pcm_temp: 45,
    at_fan_speed: 3, load_power_kw: 0.62, battery_power_kw: -0.7,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'heat', grid_online: true,
  },
  fault: {
    pv_power: 0.00, pv_sun: 0.0, bat_soc: 20,
    hp_temp: 24, hp_power: 0.0,
    tank_temp: 28, tank_volume: 30, tank_flow: 0.0,
    pump_flow: 0.0, at_temp: 24, pcm_temp: 20,
    at_fan_speed: 0, load_power_kw: 0, battery_power_kw: 0,
    pv_on: false, cb_connected: false, gs_on: false,
    hp_on: false, pump_on: false, load_on: false,
    at_mode: 'off', grid_online: false,
  },
  summer: {
    pv_power: 5.20, pv_sun: 1.0, bat_soc: 95,
    hp_temp: 22, hp_power: 6.0,
    tank_temp: 12, tank_volume: 85, tank_flow: 4.5,
    pump_flow: 4.5, at_temp: 22, pcm_temp: 18,
    at_fan_speed: 4, load_power_kw: 0.62, battery_power_kw: -1.2,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'cool', grid_online: true,
  },
  winter: {
    pv_power: 0.80, pv_sun: 0.15, bat_soc: 35,
    hp_temp: 28, hp_power: 5.5,
    tank_temp: 55, tank_volume: 50, tank_flow: 3.5,
    pump_flow: 3.5, at_temp: 28, pcm_temp: 40,
    at_fan_speed: 4, load_power_kw: 0.62, battery_power_kw: -0.9,
    pv_on: true, cb_connected: true, gs_on: true,
    hp_on: true, pump_on: true, load_on: true,
    at_mode: 'heat', grid_online: true,
  },
};

export const PRESET_LABELS: Record<string, string> = {
  daytime: '☀ 日间满发',
  evening: '🌆 傍晚',
  night: '🌙 夜间',
  cooling: '❄ 全力制冷',
  heating: '♨ 全力制热',
  hotWater: '🔥 高温水',
  fault: '⚠ 故障演练',
  summer: '☀🌡 盛夏',
  winter: '❄🌡 寒冬',
};