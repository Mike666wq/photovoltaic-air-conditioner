import { useSimStore, type SimulationState } from '../store/simulation';
import {
  PERSIST_APP_ID,
  PERSIST_FILE_TYPE,
  PERSIST_SCHEMA_VERSION,
  type PersistedCable,
  type PersistedDocument,
  type PersistedMeter,
  type PersistedPreferences,
  type PersistedSimulation,
} from '../data/saveSchema';
import { PRESET_METERS, type MeterBind } from '../data/meters';

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

type JsonObject = Record<string, unknown>;

const CABLE_KINDS = new Set(['power', 'refrigerant', 'water']);
const CABLE_DIRECTIONS = new Set(['forward', 'reverse']);
const CABLE_DIRECTION_MODES = new Set(['auto', 'forward', 'reverse']);
const CABLE_ROUTE_MODES = new Set(['straight', 'orthogonal-auto', 'orthogonal-manual']);
const METER_TYPES = new Set(['power-meter', 'temp-sensor']);
const METER_MOUNTS = new Set(['free', 'component', 'cable']);
const METER_BINDS = new Set<MeterBind>([
  'meter-d', 'meter-du', 'env-temp', 'supply-temp', 'return-temp', 'outlet-temp',
]);

function fail(path: string, message: string): never {
  throw new DocumentValidationError(`${path}：${message}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
  return value as JsonObject;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '必须是字符串');
  return value;
}

function finiteAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数值');
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '必须是布尔值');
  return value;
}

function enumAt<T extends string>(value: unknown, allowed: ReadonlySet<string>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) fail(path, `值不受支持：${String(value)}`);
  return value as T;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value == null ? undefined : stringAt(value, path);
}

function pointAt(value: unknown, path: string): { x: number; y: number } {
  const point = objectAt(value, path);
  return { x: finiteAt(point.x, `${path}.x`), y: finiteAt(point.y, `${path}.y`) };
}

function optionalPoint(value: unknown, path: string): { x: number; y: number } | null {
  return value == null ? null : pointAt(value, path);
}

const NUMERIC_SIM_FIELDS = [
  'pv_power', 'pv_sun', 'bat_soc', 'hp_temp', 'hp_power', 'tank_temp',
  'tank_volume', 'tank_flow', 'pump_flow', 'at_temp', 'pl_flow', 'rl_flow',
  'wl_flow', 'at_fan_speed', 'pcm_temp', 'load_power_kw', 'battery_power_kw',
] as const;

const BOOLEAN_SIM_FIELDS = [
  'pv_on', 'cb_connected', 'gs_on', 'hp_on', 'pump_on', 'load_on',
] as const;

function validateSimulation(value: unknown, legacy: boolean): PersistedSimulation {
  const raw = objectAt(value, 'simulation');
  const result = {} as PersistedSimulation;
  for (const field of NUMERIC_SIM_FIELDS) result[field] = finiteAt(raw[field], `simulation.${field}`);
  for (const field of BOOLEAN_SIM_FIELDS) result[field] = booleanAt(raw[field], `simulation.${field}`);
  result.at_mode = enumAt(raw.at_mode, new Set(['cool', 'heat', 'off']), 'simulation.at_mode');
  result.grid_online = raw.grid_online == null && legacy ? true : booleanAt(raw.grid_online, 'simulation.grid_online');
  result.sac_water_level = raw.sac_water_level == null && legacy ? 72 : finiteAt(raw.sac_water_level, 'simulation.sac_water_level');
  result.sac_water_temp = raw.sac_water_temp == null && legacy ? 18 : finiteAt(raw.sac_water_temp, 'simulation.sac_water_temp');
  result.sac_fan_speed = raw.sac_fan_speed == null && legacy ? 0.75 : finiteAt(raw.sac_fan_speed, 'simulation.sac_fan_speed');
  result.sac_outlet_temp = raw.sac_outlet_temp == null && legacy ? 22 : finiteAt(raw.sac_outlet_temp, 'simulation.sac_outlet_temp');
  result.sac_on = raw.sac_on == null && legacy ? true : booleanAt(raw.sac_on, 'simulation.sac_on');
  return result;
}

function validateCable(value: unknown, index: number, legacy: boolean): PersistedCable {
  const path = `layout.cables[${index}]`;
  const raw = objectAt(value, path);
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) fail(`${path}.segments`, '至少需要一个线段');
  const segments = raw.segments.map((item, segmentIndex) => {
    const segment = objectAt(item, `${path}.segments[${segmentIndex}]`);
    return {
      fromAnchorId: stringAt(segment.fromAnchorId, `${path}.segments[${segmentIndex}].fromAnchorId`),
      toAnchorId: stringAt(segment.toAnchorId, `${path}.segments[${segmentIndex}].toAnchorId`),
    };
  });
  const routeMode = raw.routeMode == null
    ? 'orthogonal-auto'
    : enumAt<NonNullable<PersistedCable['routeMode']>>(raw.routeMode, CABLE_ROUTE_MODES, `${path}.routeMode`);
  const manualWaypoints = raw.manualWaypoints == null
    ? undefined
    : Array.isArray(raw.manualWaypoints)
      ? raw.manualWaypoints.map((point, pointIndex) => pointAt(point, `${path}.manualWaypoints[${pointIndex}]`))
      : fail(`${path}.manualWaypoints`, '必须是坐标数组');
  if (routeMode === 'orthogonal-manual' && segments.length === 1 && !manualWaypoints?.length) {
    fail(`${path}.manualWaypoints`, '人工正交路由必须至少包含一个折点');
  }
  return {
    id: stringAt(raw.id, `${path}.id`),
    kind: enumAt(raw.kind, CABLE_KINDS, `${path}.kind`),
    segments,
    floatingFrom: optionalPoint(raw.floatingFrom, `${path}.floatingFrom`),
    floatingTo: optionalPoint(raw.floatingTo, `${path}.floatingTo`),
    animationEnabled: raw.animationEnabled == null && legacy ? true : booleanAt(raw.animationEnabled, `${path}.animationEnabled`),
    direction: raw.direction == null && legacy ? 'forward' : enumAt(raw.direction, CABLE_DIRECTIONS, `${path}.direction`),
    directionMode: raw.directionMode == null || raw.directionMode === 'auto'
      ? (raw.direction === 'reverse' ? 'reverse' : 'forward')
      : enumAt<NonNullable<PersistedCable['directionMode']>>(raw.directionMode, CABLE_DIRECTION_MODES, `${path}.directionMode`),
    routeMode,
    manualWaypoints,
  };
}

function validateMeter(value: unknown, index: number): PersistedMeter {
  const path = `layout.meters[${index}]`;
  const raw = objectAt(value, path);
  const mount = enumAt<PersistedMeter['mount']>(raw.mount, METER_MOUNTS, `${path}.mount`);
  const bind = raw.bind == null ? undefined : enumAt<MeterBind>(raw.bind, METER_BINDS, `${path}.bind`);
  const offsetOnCable = raw.offsetOnCable == null ? undefined : finiteAt(raw.offsetOnCable, `${path}.offsetOnCable`);
  if (offsetOnCable != null && (offsetOnCable < 0 || offsetOnCable > 1)) fail(`${path}.offsetOnCable`, '必须位于 0..1');
  const cableId = optionalString(raw.cableId, `${path}.cableId`);
  const anchorId = optionalString(raw.anchorId, `${path}.anchorId`);
  if (mount === 'cable' && !cableId) fail(`${path}.cableId`, '线缆挂载仪表必须指定 cableId');
  if (mount === 'component' && !anchorId) fail(`${path}.anchorId`, '部件挂载仪表必须指定 anchorId');
  return {
    id: stringAt(raw.id, `${path}.id`),
    type: enumAt(raw.type, METER_TYPES, `${path}.type`),
    mount,
    cableId,
    offsetOnCable,
    anchorId,
    bind,
    position: pointAt(raw.position, `${path}.position`),
    presetVb: raw.presetVb == null ? undefined : pointAt(raw.presetVb, `${path}.presetVb`),
  };
}

function validateNoCableReferenceCycles(cables: PersistedCable[]): void {
  const byId = new Map(cables.map((cable) => [cable.id, cable]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const refs = (cable: PersistedCable) => cable.segments.flatMap((segment) => [segment.fromAnchorId, segment.toAnchorId])
    .flatMap((anchor) => {
      const match = anchor.match(/^cable:(.+)\.(from|to)$/);
      if (!match) return [];
      if (!byId.has(match[1])) fail(`layout.cables.${cable.id}`, `引用了不存在的线缆 ${match[1]}`);
      return [match[1]];
    });
  const visit = (id: string) => {
    if (visiting.has(id)) fail(`layout.cables.${id}`, '检测到线缆引用环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of refs(byId.get(id)!)) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const cable of cables) visit(cable.id);
}

function validateLayout(value: unknown, legacy: boolean): PersistedDocument['layout'] {
  const raw = objectAt(value, 'layout');
  const rawPositions = objectAt(raw.positions, 'layout.positions');
  const positions = Object.fromEntries(Object.entries(rawPositions).map(([id, point]) => [id, pointAt(point, `layout.positions.${id}`)]));
  if (!Array.isArray(raw.cables)) fail('layout.cables', '必须是数组');
  if (!Array.isArray(raw.meters)) fail('layout.meters', '必须是数组');
  const cables = raw.cables.map((cable, index) => validateCable(cable, index, legacy));
  const meters = raw.meters.map(validateMeter);
  const cableIds = new Set<string>();
  for (const cable of cables) {
    if (!cable.id || cableIds.has(cable.id)) fail('layout.cables', `线缆 id 为空或重复：${cable.id}`);
    cableIds.add(cable.id);
  }
  const meterIds = new Set<string>();
  for (const meter of meters) {
    if (!meter.id || meterIds.has(meter.id)) fail('layout.meters', `仪表 id 为空或重复：${meter.id}`);
    meterIds.add(meter.id);
    if (meter.cableId && !cableIds.has(meter.cableId)) fail(`layout.meters.${meter.id}.cableId`, '引用的线缆不存在');
  }
  validateNoCableReferenceCycles(cables);
  return { positions, cables, meters };
}

function validatePreferences(value: unknown, legacy: boolean): PersistedPreferences {
  const raw = objectAt(value, 'preferences');
  const gridSize = finiteAt(raw.gridSize, 'preferences.gridSize');
  if (gridSize < 5 || gridSize > 100) fail('preferences.gridSize', '必须位于 5..100');
  return {
    showGrid: booleanAt(raw.showGrid, 'preferences.showGrid'),
    showCoords: booleanAt(raw.showCoords, 'preferences.showCoords'),
    gridSize,
    animationOn: booleanAt(raw.animationOn, 'preferences.animationOn'),
    snapToGrid: raw.snapToGrid == null && legacy ? true : booleanAt(raw.snapToGrid, 'preferences.snapToGrid'),
    smartGuides: raw.smartGuides == null && legacy ? true : booleanAt(raw.smartGuides, 'preferences.smartGuides'),
  };
}

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
      positions: Object.fromEntries(Object.entries(s.positions).map(([id, point]) => [id, { ...point }])),
      cables: s.cables.map((c) => ({
        id: c.id,
        kind: c.kind,
        segments: c.segments.map((seg) => ({ ...seg })),
        floatingFrom: c.floatingFrom ? { ...c.floatingFrom } : null,
        floatingTo: c.floatingTo ? { ...c.floatingTo } : null,
        animationEnabled: c.animationEnabled,
        direction: c.direction,
        directionMode: c.directionMode,
        routeMode: c.routeMode,
        manualWaypoints: c.manualWaypoints?.map((point) => ({ ...point })),
      })),
      meters: s.meters.map((m) => ({
        id: m.id,
        type: m.type,
        mount: m.mount,
        cableId: m.cableId,
        offsetOnCable: m.offsetOnCable,
        anchorId: m.anchorId,
        bind: m.bind,
        position: { ...m.position },
        presetVb: m.presetVb ? { ...m.presetVb } : undefined,
      })),
    },
    preferences: {
      showGrid: s.showGrid,
      showCoords: s.showCoords,
      gridSize: s.gridSize,
      animationOn: s.animationOn,
      snapToGrid: s.snapToGrid,
      smartGuides: s.smartGuides,
    },
    injection: null,
  };
}

function extractSimulation(s: SimulationState): PersistedSimulation {
  return {
    pv_power: s.pv_power, pv_sun: s.pv_sun, bat_soc: s.bat_soc,
    hp_temp: s.hp_temp, hp_power: s.hp_power, tank_temp: s.tank_temp,
    tank_volume: s.tank_volume, tank_flow: s.tank_flow, pump_flow: s.pump_flow,
    at_temp: s.at_temp, pl_flow: s.pl_flow, rl_flow: s.rl_flow, wl_flow: s.wl_flow,
    at_fan_speed: s.at_fan_speed, pcm_temp: s.pcm_temp,
    load_power_kw: s.load_power_kw, battery_power_kw: s.battery_power_kw,
    sac_water_level: s.sac_water_level, sac_water_temp: s.sac_water_temp,
    sac_fan_speed: s.sac_fan_speed, sac_outlet_temp: s.sac_outlet_temp,
    pv_on: s.pv_on, cb_connected: s.cb_connected, gs_on: s.gs_on,
    hp_on: s.hp_on, pump_on: s.pump_on, load_on: s.load_on,
    at_mode: s.at_mode, grid_online: s.grid_online, sac_on: s.sac_on,
  };
}

/** 深校验并把受支持的 v1 文档迁移为当前 v2 世界坐标文档。 */
export function validateDocument(value: unknown): PersistedDocument {
  const raw = objectAt(value, '文档');
  const version = finiteAt(raw.schemaVersion, 'schemaVersion');
  if (version !== 1 && version !== PERSIST_SCHEMA_VERSION) fail('schemaVersion', `不支持的版本 ${version}`);
  if (raw.appId !== PERSIST_APP_ID) fail('appId', `不匹配：${String(raw.appId)}`);
  if (raw.fileType !== PERSIST_FILE_TYPE) fail('fileType', `不匹配：${String(raw.fileType)}`);
  const legacy = version === 1;
  const injection = raw.injection == null ? null : (() => {
    const item = objectAt(raw.injection, 'injection');
    return {
      sourceFile: item.sourceFile == null ? null : stringAt(item.sourceFile, 'injection.sourceFile'),
      injectedAt: item.injectedAt == null ? null : stringAt(item.injectedAt, 'injection.injectedAt'),
      rowsCount: item.rowsCount == null ? null : finiteAt(item.rowsCount, 'injection.rowsCount'),
    };
  })();
  return {
    schemaVersion: PERSIST_SCHEMA_VERSION,
    appId: PERSIST_APP_ID,
    fileType: PERSIST_FILE_TYPE,
    name: stringAt(raw.name, 'name'),
    savedAt: stringAt(raw.savedAt, 'savedAt'),
    updatedAt: stringAt(raw.updatedAt, 'updatedAt'),
    simulation: validateSimulation(raw.simulation, legacy),
    layout: validateLayout(raw.layout, legacy),
    preferences: validatePreferences(raw.preferences, legacy),
    injection,
  };
}

function scheduleCanvasFitAfterCommit(): void {
  if (typeof window === 'undefined') return;
  const dispatch = () => window.dispatchEvent(new Event('canvas-fit'));
  if (typeof window.requestAnimationFrame !== 'function') {
    window.setTimeout(dispatch, 0);
    return;
  }
  window.requestAnimationFrame(() => window.requestAnimationFrame(dispatch));
}

/** 原子恢复场景；数据文件不属于场景文档，加载时必须退出并清空旧回放。 */
export function applyDocumentToStore(doc: PersistedDocument): void {
  const sim = doc.simulation;
  const restoredMeters = doc.layout.meters.map((meter) => {
    const preset = PRESET_METERS.find((item) => item.id === meter.id);
    const isOrigin = meter.position.x === 0 && meter.position.y === 0;
    return {
      ...meter,
      bind: meter.bind ?? preset?.bind,
      presetVb: meter.presetVb ?? (isOrigin ? preset?.presetVb : undefined),
    };
  });
  useSimStore.setState({
    ...sim,
    pv_on: sim.pv_power > 0.01 ? true : sim.pv_on,
    cables: doc.layout.cables,
    meters: restoredMeters,
    positions: doc.layout.positions,
    showGrid: doc.preferences.showGrid,
    showCoords: doc.preferences.showCoords,
    gridSize: doc.preferences.gridSize,
    animationOn: doc.preferences.animationOn,
    snapToGrid: doc.preferences.snapToGrid ?? true,
    smartGuides: doc.preferences.smartGuides ?? true,
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
    lastInjection: null,
    injectionDataset: null,
    injectionSources: [],
    timelineMode: 'combined',
    timelineCursorMs: null,
    injectionFieldAvailability: {},
    timelineIndex: -1,
    timelinePlaying: false,
    controlMode: 'simulation',
    playbackSnapshot: null,
  });
  scheduleCanvasFitAfterCommit();
}
