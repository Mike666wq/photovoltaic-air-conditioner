import { useSimStore, type SimulationState, derivePvOn } from '../store/simulation';
import {
  PERSIST_APP_ID,
  PERSIST_FILE_TYPE,
  PERSIST_SCHEMA_VERSION,
  type PersistedCable,
  type PersistedDocument,
  type PersistedExperimentSessionManifest,
  type PersistedMeter,
  type PersistedPreferences,
  type PersistedSimulation,
} from '../data/saveSchema';
import { PRESET_METERS, type MeterBind } from '../data/meters';
import { COMPONENTS } from '../data/components';
import { useAnalysisStore } from '../store/analysis';
import { validateExperimentBatch, type ExperimentBatch } from './experimentSession';
import { restoreExperimentSession, type ExperimentRestoreReport } from './sessionCoordinator';

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

type JsonObject = Record<string, unknown>;

const CABLE_KINDS = new Set(['power', 'refrigerant', 'water']);
const CABLE_DIRECTIONS = new Set(['forward', 'reverse']);
const CABLE_DIRECTION_MODES = new Set(['forward', 'reverse']);
const CABLE_ROUTE_MODES = new Set(['straight', 'orthogonal-auto', 'orthogonal-manual']);
const METER_TYPES = new Set(['power-meter', 'temp-sensor']);
const METER_MOUNTS = new Set(['free', 'component', 'cable']);
const SOURCE_FORMATS = new Set(['csv', 'xlsx', 'pdf']);
const SOURCE_ROLES = new Set(['thermal-electrical', 'battery-bms', 'mixed', 'generic']);
const METER_BINDS = new Set<MeterBind>([
  'meter-d', 'meter-du', 'env-temp', 'supply-temp', 'return-temp', 'outlet-temp',
]);
const COMPONENT_IDS = new Set(COMPONENTS.map((component) => component.id));
const ANCHOR_PATTERN = /^(.+)\.(top|bottom|left|right)$/;

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
  for (const id of Object.keys(positions)) {
    if (!COMPONENT_IDS.has(id)) fail(`layout.positions.${id}`, '不是已知部件，仪表位置应保存在 layout.meters');
  }
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
    if (meter.mount === 'component') {
      const owner = meter.anchorId?.match(ANCHOR_PATTERN)?.[1];
      if (!owner || !COMPONENT_IDS.has(owner)) fail(`layout.meters.${meter.id}.anchorId`, '引用的部件锚点不存在');
    }
  }
  const validNodeAnchor = (anchorId: string) => {
    const owner = anchorId.match(ANCHOR_PATTERN)?.[1];
    return Boolean(owner && (COMPONENT_IDS.has(owner) || meterIds.has(owner)));
  };
  for (const [cableIndex, cable] of cables.entries()) {
    for (const [segmentIndex, segment] of cable.segments.entries()) {
      const endpoints = [
        { key: 'fromAnchorId', value: segment.fromAnchorId, floating: cable.floatingFrom, mayFloat: segmentIndex === 0 },
        { key: 'toAnchorId', value: segment.toAnchorId, floating: cable.floatingTo, mayFloat: segmentIndex === cable.segments.length - 1 },
      ] as const;
      for (const endpoint of endpoints) {
        const path = `layout.cables[${cableIndex}].segments[${segmentIndex}].${endpoint.key}`;
        if (!endpoint.value) {
          if (!endpoint.mayFloat || !endpoint.floating) fail(path, '空端点必须是首尾端点且带有浮动坐标');
          continue;
        }
        if (!endpoint.value.startsWith('cable:') && !validNodeAnchor(endpoint.value)) {
          fail(path, `引用的部件或仪表锚点不存在：${endpoint.value}`);
        }
      }
    }
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
  const analysis = useAnalysisStore.getState();
  const now = new Date().toISOString();
  const referencedSourceIds = new Set(analysis.experimentBatches.flatMap((batch) => batch.sourceIds));
  const persistedSources = analysis.sources.filter((source) => referencedSourceIds.has(source.id)).map((source) => ({
    sourceId: source.id,
    cacheKey: source.id,
    sourceFile: source.sourceFile,
    format: source.format,
    role: source.profile.kind,
    rowsCount: source.rows.length,
    timeColumn: source.timeColumn,
  }));
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
    injection: analysis.experimentBatches.length ? {
      kind: 'experiment-session',
      activeBatchId: analysis.activeExperimentBatchId,
      batches: analysis.experimentBatches.map((batch) => ({ ...batch, sourceIds: [...batch.sourceIds] })),
      sources: persistedSources,
    } : null,
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

function validateExperimentManifest(value: unknown): PersistedExperimentSessionManifest {
  const raw = objectAt(value, 'injection');
  if (raw.kind !== 'experiment-session') fail('injection.kind', '必须是 experiment-session');
  if (!Array.isArray(raw.sources)) fail('injection.sources', '必须是数组');
  if (!Array.isArray(raw.batches)) fail('injection.batches', '必须是数组');
  const sources = raw.sources.map((item, index) => {
    const path = `injection.sources[${index}]`;
    const source = objectAt(item, path);
    const rowsCount = finiteAt(source.rowsCount, `${path}.rowsCount`);
    if (!Number.isInteger(rowsCount) || rowsCount < 0) fail(`${path}.rowsCount`, '必须是非负整数');
    return {
      sourceId: stringAt(source.sourceId, `${path}.sourceId`),
      cacheKey: stringAt(source.cacheKey, `${path}.cacheKey`),
      sourceFile: stringAt(source.sourceFile, `${path}.sourceFile`),
      format: enumAt<'csv' | 'xlsx' | 'pdf'>(source.format, SOURCE_FORMATS, `${path}.format`),
      role: enumAt<'thermal-electrical' | 'battery-bms' | 'mixed' | 'generic'>(source.role, SOURCE_ROLES, `${path}.role`),
      rowsCount,
      timeColumn: optionalString(source.timeColumn, `${path}.timeColumn`),
    };
  });
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId || sourceIds.has(source.sourceId)) fail('injection.sources', `数据源 id 为空或重复：${source.sourceId}`);
    sourceIds.add(source.sourceId);
  }
  const batches = raw.batches.map((item, index) => {
    const path = `injection.batches[${index}]`;
    const batch = objectAt(item, path);
    const parsed: ExperimentBatch = {
      id: stringAt(batch.id, `${path}.id`),
      name: stringAt(batch.name, `${path}.name`),
      sourceIds: Array.isArray(batch.sourceIds)
        ? batch.sourceIds.map((sourceId, sourceIndex) => stringAt(sourceId, `${path}.sourceIds[${sourceIndex}]`))
        : fail(`${path}.sourceIds`, '必须是数组'),
      anchorSourceId: stringAt(batch.anchorSourceId, `${path}.anchorSourceId`),
      toleranceMs: finiteAt(batch.toleranceMs, `${path}.toleranceMs`),
      createdAt: stringAt(batch.createdAt, `${path}.createdAt`),
      updatedAt: stringAt(batch.updatedAt, `${path}.updatedAt`),
    };
    try {
      validateExperimentBatch(parsed);
    } catch (cause) {
      fail(path, cause instanceof Error ? cause.message : '批次无效');
    }
    for (const sourceId of parsed.sourceIds) {
      if (!sourceIds.has(sourceId)) fail(`${path}.sourceIds`, `引用的缓存数据源不存在：${sourceId}`);
    }
    return parsed;
  });
  const batchIds = new Set<string>();
  for (const batch of batches) {
    if (batchIds.has(batch.id)) fail('injection.batches', `批次 id 重复：${batch.id}`);
    batchIds.add(batch.id);
  }
  const activeBatchId = raw.activeBatchId == null ? null : stringAt(raw.activeBatchId, 'injection.activeBatchId');
  if (activeBatchId && !batchIds.has(activeBatchId)) fail('injection.activeBatchId', '引用的批次不存在');
  return { kind: 'experiment-session', activeBatchId, batches, sources };
}

/** 深校验并把受支持的 v1/v2 文档迁移为当前 v3 文档。 */
export function validateDocument(value: unknown): PersistedDocument {
  const raw = objectAt(value, '文档');
  const version = finiteAt(raw.schemaVersion, 'schemaVersion');
  if (version !== 1 && version !== 2 && version !== PERSIST_SCHEMA_VERSION) fail('schemaVersion', `不支持的版本 ${version}`);
  if (raw.appId !== PERSIST_APP_ID) fail('appId', `不匹配：${String(raw.appId)}`);
  if (raw.fileType !== PERSIST_FILE_TYPE) fail('fileType', `不匹配：${String(raw.fileType)}`);
  const legacy = version === 1;
  // v1/v2 只保存了文件名/行数，无法可信恢复原始数据；迁移时明确丢弃旧占位信息。
  const injection = version === PERSIST_SCHEMA_VERSION && raw.injection != null
    ? validateExperimentManifest(raw.injection)
    : null;
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

export interface DocumentApplyResult {
  dataSession: 'none' | ExperimentRestoreReport['status'];
  restoredBatchIds: string[];
  missingSourceIds: string[];
}

/** 原子恢复场景；v3 再按轻量清单从本地缓存恢复实验会话。 */
export async function applyDocumentToStore(doc: PersistedDocument): Promise<DocumentApplyResult> {
  const sim = doc.simulation;
  const existingSession = useSimStore.getState();
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
    // 数据会话先保留在原状态；只有缓存中存在完整批次时，恢复协调器才原子替换它。
    injectionDataset: existingSession.injectionDataset,
    injectionSources: existingSession.injectionSources,
    activePlaybackSourceIds: existingSession.activePlaybackSourceIds,
    playbackAnchorSourceId: existingSession.playbackAnchorSourceId,
    playbackToleranceMs: existingSession.playbackToleranceMs,
    timelineMode: existingSession.timelineMode,
    timelineCursorMs: existingSession.timelineCursorMs,
    injectionFieldAvailability: existingSession.injectionFieldAvailability,
    timelineIndex: existingSession.timelineIndex,
    timelinePlaying: existingSession.timelinePlaying,
    controlMode: existingSession.controlMode,
    playbackSnapshot: existingSession.playbackSnapshot,
    lastInjection: existingSession.lastInjection,
    // pv_on 是 pv_power 的派生量（见 store/simulation.ts 的 derivePvOn 证据链），
    // 载入时按同一规则重新派生。保留这行是有意为之：早期 randomize() 漏了派生，
    // 仓库里 3/4 的旧场景存的就是「有功率但 pv_on=false」的矛盾档，载入时归一化才对。
    // 若删掉，这里会直接显示「光伏关闭」同时顶栏报 4.85kW，比现状更糟。
    pv_on: derivePvOn(sim.pv_power),
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
  });
  scheduleCanvasFitAfterCommit();
  if (doc.injection) {
    // replaceExisting：仅当新场景确实带回了数据源时才替换旧分析库。
    // 若缓存缺失导致恢复为空，旧库原样保留，不做不可逆销毁。
    const report = await restoreExperimentSession(doc.injection, { replaceExisting: true });
    return {
      dataSession: report.status,
      restoredBatchIds: report.restoredBatchIds,
      missingSourceIds: report.missingSourceIds,
    };
  }
  // 场景没有可恢复的实验清单时，保留现有数据会话；场景的布局和仿真参数仍已更新。
  return { dataSession: 'none', restoredBatchIds: [], missingSourceIds: [] };
}
