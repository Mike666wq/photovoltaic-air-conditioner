import { useSimStore } from '../store/simulation';
import {
  PERSIST_APP_ID,
  PERSIST_FILE_TYPE,
  PERSIST_SCHEMA_VERSION,
  type PersistedDocument,
  type PersistedSimulation,
} from '../data/saveSchema';
import { PRESET_METERS } from '../data/meters';

export class DocumentValidationError extends Error {}


export function serializeState(name: string): PersistedDocument {
  const s = useSimStore.getState();
  const now = new Date().toISOString();
  return {
    schemaVersion: PERSIST_SCHEMA_VERSION,
    appId: PERSIST_APP_ID,
    fileType: PERSIST_FILE_TYPE,
    name,
    savedAt: now,
    updatedAt: now,
    simulation: extractSimulation(s),
    layout: {
      positions: s.positions,
      cables: s.cables.map((c) => ({
        id: c.id,
        kind: c.kind,
        segments: c.segments.map((seg) => ({ fromAnchorId: seg.fromAnchorId, toAnchorId: seg.toAnchorId })),
        floatingFrom: c.floatingFrom ?? null,
        floatingTo: c.floatingTo ?? null,
        animationEnabled: c.animationEnabled,
        direction: c.direction,
      })),
      meters: s.meters.map((m) => ({
        id: m.id,
        type: m.type,
        mount: m.mount,
        cableId: m.cableId,
        offsetOnCable: m.offsetOnCable,
        anchorId: m.anchorId,
        bind: m.bind,
        position: m.position ? { x: m.position.x, y: m.position.y } : { x: 0, y: 0 },
        presetVb: m.presetVb ? { x: m.presetVb.x, y: m.presetVb.y } : undefined,
      })),
    },
    preferences: {
      showGrid: s.showGrid,
      showCoords: s.showCoords,
      gridSize: s.gridSize,
      animationOn: s.animationOn,
    },
    injection: null,
  };
}



function extractSimulation(s: any): PersistedSimulation {
  return {
    pv_power: s.pv_power,
    pv_sun: s.pv_sun,
    bat_soc: s.bat_soc,
    hp_temp: s.hp_temp,
    hp_power: s.hp_power,
    tank_temp: s.tank_temp,
    tank_volume: s.tank_volume,
    tank_flow: s.tank_flow,
    pump_flow: s.pump_flow,
    at_temp: s.at_temp,
    pl_flow: s.pl_flow,
    rl_flow: s.rl_flow,
    wl_flow: s.wl_flow,
    at_fan_speed: s.at_fan_speed,
    pcm_temp: s.pcm_temp,
    load_power_kw: s.load_power_kw,
    battery_power_kw: s.battery_power_kw,
    sac_water_level: s.sac_water_level,
    sac_water_temp: s.sac_water_temp,
    sac_fan_speed: s.sac_fan_speed,
    sac_outlet_temp: s.sac_outlet_temp,
    pv_on: s.pv_on,
    cb_connected: s.cb_connected,
    gs_on: s.gs_on,
    hp_on: s.hp_on,
    pump_on: s.pump_on,
    load_on: s.load_on,
    at_mode: s.at_mode,
    grid_online: s.grid_online,
    sac_on: s.sac_on,
  };
}

/**
 * validateDocument — 严格 v1 schema 校验。
 */
export function validateDocument(value: unknown): PersistedDocument {
  if (!value || typeof value !== 'object') {
    throw new DocumentValidationError('文档格式错误');
  }
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== PERSIST_SCHEMA_VERSION) {
    throw new DocumentValidationError(`不支持的 schemaVersion: ${String(v.schemaVersion)}`);
  }
  if (v.appId !== PERSIST_APP_ID) {
    throw new DocumentValidationError(`appId 不匹配: ${String(v.appId)}`);
  }
  if (v.fileType !== PERSIST_FILE_TYPE) {
    throw new DocumentValidationError(`fileType 不匹配: ${String(v.fileType)}`);
  }
  if (!v.simulation || typeof v.simulation !== 'object') {
    throw new DocumentValidationError('simulation 字段缺失');
  }
  if (!v.layout || typeof v.layout !== 'object') {
    throw new DocumentValidationError('layout 字段缺失');
  }
  if (!v.preferences || typeof v.preferences !== 'object') {
    throw new DocumentValidationError('preferences 字段缺失');
  }
  return v as unknown as PersistedDocument;
}

/**
 * applyDocumentToStore
 *
 * v1 文件 → store：positions / cable floating / meter.position 都是 CSS 像素，
 * 直接拷贝（store 持有的也是 CSS px）。加载时强制侧栏展开、全屏关闭。
 */
export function applyDocumentToStore(doc: PersistedDocument): void {
  const sim = doc.simulation;
  // v1 早期场景没有保存 bind / presetVb；根据稳定的预置仪表 id 补齐，
  // 但用户曾拖动过的仪表仍以存档 position 为准。
  const restoredMeters = doc.layout.meters.map((meter) => {
    const preset = PRESET_METERS.find((item) => item.id === meter.id);
    const position = meter.position ?? preset?.position ?? { x: 0, y: 0 };
    const isOrigin = position.x === 0 && position.y === 0;
    return {
      ...meter,
      position,
      bind: meter.bind ?? preset?.bind,
      presetVb: meter.presetVb ?? (isOrigin ? preset?.presetVb : undefined),
    };
  });
  useSimStore.setState({
    pv_power: sim.pv_power,
    pv_sun: sim.pv_sun,
    bat_soc: sim.bat_soc,
    hp_temp: sim.hp_temp,
    hp_power: sim.hp_power,
    tank_temp: sim.tank_temp,
    tank_volume: sim.tank_volume,
    tank_flow: sim.tank_flow,
    pump_flow: sim.pump_flow,
    at_temp: sim.at_temp,
    pl_flow: sim.pl_flow,
    rl_flow: sim.rl_flow,
    wl_flow: sim.wl_flow,
    at_fan_speed: sim.at_fan_speed,
    pcm_temp: sim.pcm_temp,
    load_power_kw: sim.load_power_kw,
    battery_power_kw: sim.battery_power_kw,
    // 兼容在水冷风扇接入前保存的 v1 场景文件
    sac_water_level: sim.sac_water_level ?? 72,
    sac_water_temp: sim.sac_water_temp ?? 18,
    sac_fan_speed: sim.sac_fan_speed ?? 0.75,
    sac_outlet_temp: sim.sac_outlet_temp ?? 22,
    pv_on: sim.pv_on,
    cb_connected: sim.cb_connected,
    gs_on: sim.gs_on,
    hp_on: sim.hp_on,
    pump_on: sim.pump_on,
    load_on: sim.load_on,
    at_mode: sim.at_mode,
    grid_online: sim.grid_online,
    sac_on: sim.sac_on ?? true,
    cables: doc.layout.cables as any,
    meters: restoredMeters as any,
    positions: doc.layout.positions,
    showGrid: doc.preferences.showGrid,
    showCoords: doc.preferences.showCoords,
    gridSize: doc.preferences.gridSize,
    animationOn: doc.preferences.animationOn,
    selectedId: null,
    draggingId: null,
    hoverId: null,
    selectedCable: null,
    selectedMeter: null,
    cableDrag: null,
    leftPanelOpen: true,
    rightPanelOpen: true,
    fullscreen: false,
    cardPositions: {},
  });
  // 旧文件中的布局可能来自不同窗口尺寸；加载后统一回正，确保全部内容可见。
  window.dispatchEvent(new Event('canvas-fit'));
}
