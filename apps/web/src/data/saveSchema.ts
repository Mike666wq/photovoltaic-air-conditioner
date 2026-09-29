import type { SimulationState } from '../store/simulation';
import type { MeterBind } from './meters';
import type { ExperimentBatch } from '../services/experimentSession';

/** v3 以轻量清单持久化实验会话，原始数据由 IndexedDB 缓存，不写入场景 JSON。 */
export const PERSIST_SCHEMA_VERSION = 3;
export const PERSIST_APP_ID = 'photovoltaic-air-conditioner';
export const PERSIST_FILE_TYPE = 'simulation-state';

export interface PersistedSimulation {
  // 21 numeric fields（含太阳能水冷风扇 4 个独立控制字段）
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
  sac_water_level: number;
  sac_water_temp: number;
  sac_fan_speed: number;
  sac_outlet_temp: number;
  // 7 flags + at_mode + grid_online (Fix B3)
  pv_on: boolean;
  cb_connected: boolean;
  gs_on: boolean;
  hp_on: boolean;
  pump_on: boolean;
  load_on: boolean;
  at_mode: 'cool' | 'heat' | 'off';
  grid_online: boolean;
  sac_on: boolean;
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
   * 端点未吸附时的浮动坐标。v2：画布世界坐标。
   */
  floatingFrom: { x: number; y: number } | null;
  /** 同 floatingFrom：v2 = viewBox 坐标。 */
  floatingTo: { x: number; y: number } | null;
  animationEnabled: boolean;
  direction: 'forward' | 'reverse';
  /** v1/v2 中的 auto 会在读取时迁移为当时保存的 forward/reverse。 */
  directionMode?: 'forward' | 'reverse';
  routeMode?: 'straight' | 'orthogonal-auto' | 'orthogonal-manual';
  manualWaypoints?: Array<{ x: number; y: number }>;
}

export interface PersistedMeter {
  id: string;
  type: 'power-meter' | 'temp-sensor';
  mount: 'cable' | 'component' | 'free';
  cableId?: string;
  offsetOnCable?: number;
  anchorId?: string;
  /** 仪表采集数据源绑定。缺失时按预置仪表 id 兼容旧场景。 */
  bind?: MeterBind;
  /**
   * 仪表 free 时的位置。v2：画布世界坐标。
   */
  position: { x: number; y: number };
  /** 预置仪表的世界坐标，避免载入后退回 (0, 0)。 */
  presetVb?: { x: number; y: number };
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
  snapToGrid?: boolean;
  smartGuides?: boolean;
}

export interface PersistedSourceReference {
  sourceId: string;
  cacheKey: string;
  sourceFile: string;
  format: 'csv' | 'xlsx' | 'pdf';
  role: 'thermal-electrical' | 'battery-bms' | 'mixed' | 'generic';
  rowsCount: number;
  timeColumn?: string;
}

export interface PersistedExperimentSessionManifest {
  kind: 'experiment-session';
  activeBatchId: string | null;
  batches: ExperimentBatch[];
  sources: PersistedSourceReference[];
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
  injection: PersistedExperimentSessionManifest | null;
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
      sac_water_level: 72, sac_water_temp: 18, sac_fan_speed: 0.75, sac_outlet_temp: 22,
      pv_on: true, cb_connected: true, gs_on: true,
      hp_on: true, pump_on: true, load_on: true,
      at_mode: 'cool', grid_online: true,
      sac_on: true,
    },
    layout: {
       positions: {},
       cables: [],
       meters: [],
    },
     preferences: {
       showGrid: true, showCoords: false, gridSize: 20, animationOn: true,
       snapToGrid: true, smartGuides: true,
     },
     injection: null,
  };
}

export type { SimulationState };
