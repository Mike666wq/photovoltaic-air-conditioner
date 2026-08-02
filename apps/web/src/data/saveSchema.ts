import type { SimulationState } from '../store/simulation';

export const PERSIST_SCHEMA_VERSION = 1;
export const PERSIST_APP_ID = 'photovoltaic-air-conditioner';
export const PERSIST_FILE_TYPE = 'simulation-state';

export interface PersistedSimulation {
  // 17 numeric fields (M1.5 Round 9+: 含 load_power_kw / battery_power_kw)
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
  pl_flow: number;
  rl_flow: number;
  wl_flow: number;
  at_fan_speed: number;
  pcm_temp: number;
  load_power_kw: number;
  battery_power_kw: number;
  // 7 flags + at_mode + grid_online (Fix B3)
  pv_on: boolean;
  cb_connected: boolean;
  gs_on: boolean;
  hp_on: boolean;
  pump_on: boolean;
  load_on: boolean;
  at_mode: 'cool' | 'heat' | 'off';
  grid_online: boolean;
}

export interface PersistedCableSegment {
  fromAnchorId: string;
  toAnchorId: string;
}

export interface PersistedCable {
  id: string;
  kind: 'power' | 'refrigerant' | 'water';
  segments: PersistedCableSegment[];
  /**
   * 端点未吸附时的浮动坐标。v2：viewBox 坐标系（1800×1100），与 data/components.ts 一致。
   */
  floatingFrom: { x: number; y: number } | null;
  /** 同 floatingFrom：v2 = viewBox 坐标。 */
  floatingTo: { x: number; y: number } | null;
  animationEnabled: boolean;
  direction: 'forward' | 'reverse';
}

export interface PersistedMeter {
  id: string;
  type: 'power-meter' | 'temp-sensor';
  mount: 'cable' | 'component' | 'free';
  cableId?: string;
  offsetOnCable?: number;
  anchorId?: string;
  /**
   * 仪表 free 时的位置。v2：viewBox 坐标系（1800×1100）。
   */
  position: { x: number; y: number };
}

export interface PersistedLayout {
  positions: Record<string, { x: number; y: number }>;
  cables: PersistedCable[];
  meters: PersistedMeter[];
}

export interface PersistedPreferences {
  showGrid: boolean;
  showCoords: boolean;
  gridSize: number;
  animationOn: boolean;
}

export interface PersistedInjectionInfo {
  sourceFile: string | null;
  injectedAt: string | null;
  rowsCount: number | null;
}

export interface PersistedDocument {
  schemaVersion: number;
  appId: string;
  fileType: string;
  name: string;
  savedAt: string;
  updatedAt: string;
  simulation: PersistedSimulation;
  layout: PersistedLayout;
  preferences: PersistedPreferences;
  injection: PersistedInjectionInfo | null;
}

export function createEmptyDocument(): PersistedDocument {
  return {
    schemaVersion: PERSIST_SCHEMA_VERSION,
    appId: PERSIST_APP_ID,
    fileType: PERSIST_FILE_TYPE,
    name: '未命名场景',
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    simulation: {
      pv_power: 3.24, pv_sun: 0.6, bat_soc: 78,
      hp_temp: 24, hp_power: 3.2,
      tank_temp: 28, tank_volume: 65, tank_flow: 2.5,
      pump_flow: 2.5, at_temp: 24,
      pl_flow: 3.0, rl_flow: 2.5, wl_flow: 2.5,
      at_fan_speed: 3, pcm_temp: 28,
      load_power_kw: 0.62, battery_power_kw: 0,
      pv_on: true, cb_connected: true, gs_on: true,
      hp_on: true, pump_on: true, load_on: true,
      at_mode: 'cool', grid_online: true,
    },
    layout: {
       positions: {},
       cables: [],
       meters: [],
    },
     preferences: { showGrid: true, showCoords: false, gridSize: 20, animationOn: true },
     injection: null,
  };
}

export type { SimulationState };
