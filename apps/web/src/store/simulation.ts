import { create } from 'zustand';
import { PRESETS } from '../data/presets';
import { CABLES as DEFAULT_CABLES, type Cable, type CableRoutingMode } from '../data/cables';
import type { CableKind } from '../data/palettes';
import { PRESET_METERS, type MeterInstance, type MeterBind } from '../data/meters';
import type { MeterType } from '../data/palettes';
import { matchColumnToField, type NumericFieldKey } from '../services/dataMapper';
import { detectSourceProfile, type SourceProfileKind } from '../data/sourceProfile';
import { detectTimeColumn, parseDatasetTime } from '../services/dataset';
import {
  prepareDataSource,
  type PreparedDataSource,
  type SourceQualityReport,
} from '../services/dataSourcePipeline';

export type AtMode = 'cool' | 'heat' | 'off';

export type InjectionSourceRole = SourceProfileKind;
export type TimelineMode = 'combined' | 'thermal-electrical' | 'battery-bms' | 'mixed' | 'generic';
export type ControlMode = 'simulation' | 'replay';

export type PlaybackStatusKey =
  | 'pv_on'
  | 'cb_connected'
  | 'gs_on'
  | 'grid_online'
  | 'hp_on'
  | 'pump_on'
  | 'load_on'
  | 'at_mode';

export interface PlaybackSnapshot {
  timestamp: number;
  values: Record<string, number>;
  availability: Record<string, boolean>;
  provenance: Record<string, { sourceId: string; column: string }>;
  statuses: Partial<Record<PlaybackStatusKey, boolean | AtMode | 'unknown'>>;
  statusAvailability: Partial<Record<PlaybackStatusKey, boolean>>;
  sourceIds: string[];
  sourceRowIndices: Record<string, number>;
  sourceTimestamps: Record<string, number>;
}

export interface InjectionDataset {
  sourceId: string;
  sourceFile: string;
  format: 'csv' | 'xlsx' | 'pdf';
  headers: string[];
  rows: Array<Record<string, string>>;
  /** 质量隔离前的完整原始行；回放只消费 rows 中的有效行。 */
  rawRows: Array<Record<string, string>>;
  quality: SourceQualityReport;
  prepared: PreparedDataSource;
  timeColumn?: string;
  /** 用户在导入向导确认过的映射；回放阶段不得再次模糊猜测。 */
  mapping: Record<string, NumericFieldKey>;
  role: InjectionSourceRole;
  injectedAt: string;
}

export interface SimulationState {
  // 20 个滑块参数
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
  at_fan_speed: number;  // M1.5 Round 9 新增：末端风档位（0-4）
  pcm_temp: number;       // M1.5 Round 9 改：完全独立滑块（不再覆盖自 tank_temp）
  load_power_kw: number;  // Fix B1：负载功率（独立滑块，替代 pv_power 派生）
  battery_power_kw: number;  // 电池功率（正=放电，负=充电；BMS 电流符号由独立配置解释）
  sac_water_level: number;   // 太阳能水冷风扇内置水箱水位（%）
  sac_water_temp: number;    // 太阳能水冷风扇内置水温（℃）
  sac_fan_speed: number;     // 太阳能水冷风扇风速（0..1）
  sac_outlet_temp: number;   // 太阳能水冷风扇出风温度（℃）

  // 7 个可点击部件状态
  pv_on: boolean;
  cb_connected: boolean;
  gs_on: boolean;
  hp_on: boolean;
  pump_on: boolean;
  load_on: boolean;
  at_mode: AtMode;
  grid_online: boolean;  // Fix B3：电网在线状态（独立于 gs_on，M2 引擎可独立驱动）
  sac_on: boolean;       // 太阳能水冷风扇总开关

  // === 画板布局 ===
  positions: Record<string, { x: number; y: number }>;
  selectedId: string | null;
  draggingId: string | null;
  hoverId: string | null;
  showGrid: boolean;
  showCoords: boolean;
  gridSize: number;
  snapToGrid: boolean;
  smartGuides: boolean;
  editMode: boolean;

  /** 全局动画开关（默认 true → CSS 动画运行 + Canvas 粒子可见；与 demo.html 一致） */
  animationOn: boolean;

  // === 线缆 ===
  /** 默认线缆 + 用户拖出的线缆 */
  cables: Cable[];
  /** 当前选中的线缆 id */
  selectedCable: string | null;

  /** 全局线缆端点拖动状态（用于广播 + 点亮画布） */
  cableDrag: {
    cableId: string;
    end: 'from' | 'to';
    pos: { x: number; y: number };
    snapAnchorId: string | null;
  } | null;

  /** 画布上所有仪表实例 */
  meters: MeterInstance[];
  /** 当前选中的仪表 id */
  selectedMeter: string | null;

  /** 左侧调色板是否展开（false = 折叠成 40px 图标条） */
  leftPanelOpen: boolean;
  /** 右侧控制面板是否展开（false = 折叠成 40px 图标条） */
  rightPanelOpen: boolean;
  /** 全屏模式：两侧栏都隐藏，画布占 100% 视口 */
  fullscreen: boolean;

  /** 部件卡片 + 仪表卡片的画布像素 rect（用于 updateCableEnd 兑底） */
  cardPositions: Record<string, { x: number; y: number; w: number; h: number }>;

  /** M2-α：最近一次数据注入的元信息（来源文件 + 行数 + 时间） */
  lastInjection: { sourceFile: string; rowsCount: number; injectedAt: string } | null;

  /**
   * M2-β：完整采集数据集（导入后保留原始行，供仪表实例按 bind 显示 + 大屏图表分析）。
   * 时序回放时按 timelineIndex 取当前行。
   */
  injectionDataset: InjectionDataset | null;

  /** 多源原始数据。不同角色追加保存，不再由后导入文件覆盖。 */
  injectionSources: InjectionDataset[];
  /** 当前回放会话显式选中的来源；历史来源保留但不自动参与严格交集。 */
  activePlaybackSourceIds: string[];
  /** 严格同步的主时间轴来源；必须属于 activePlaybackSourceIds。 */
  playbackAnchorSourceId: string | null;
  /** 严格同步允许的最近邻时间差，默认 2 秒。 */
  playbackToleranceMs: number;
  /** combined 默认以热工/电表源为主时间轴；BMS 模式保留 2 秒原始时间轴。 */
  timelineMode: TimelineMode;
  /** 统一真实时间游标（Unix ms）；各源按它解析当前行。 */
  timelineCursorMs: number | null;
  /** 本帧由采集数据明确提供/缺失的 store 字段，用于 UI 区分“不可用”和仿真默认值。 */
  injectionFieldAvailability: Partial<Record<NumericFieldKey, boolean>>;

  /** 时序回放当前帧索引（-1 = 未导入/静态模式，显示最后一行或默认值） */
  timelineIndex: number;
  /** 时序回放播放状态 */
  timelinePlaying: boolean;
  /** 回放倍速：仿真时间游标的推进倍率，实际可选 1 / 60 / 120 / 600（见 TimelineControls） */
  timelineSpeed: number;

  /** 仿真手控与采集回放互斥，防止同一字段被时间轴和滑块交替覆盖。 */
  controlMode: ControlMode;
  /** 当前 canonical 同步帧，供原理图、仪表和详情共同消费。 */
  playbackSnapshot: PlaybackSnapshot | null;

  /** PCM 双相变材料显示切换：'T0' | 'T1' */
  pcm_temp_select: 'T0' | 'T1';
}

interface SimStore extends SimulationState {
  setField: (key: keyof SimulationState, value: number | boolean) => void;
  togglePv: () => void;
  toggleCb: () => void;
  toggleGs: () => void;
  toggleHp: () => void;
  togglePump: () => void;
  cycleAt: () => void;
  toggleLoad: () => void;  // Fix B6：原 cycleLoad 重命名
  toggleSolarAirCooler: () => void;
  loadPreset: (name: keyof typeof PRESETS) => void;
  randomize: () => void;
  resetAll: () => void;
  toggleAnimation: () => void;

  // layout actions
  setPosition: (id: string, x: number, y: number) => void;
  setNodePositions: (positions: Record<string, { x: number; y: number }>) => void;
  selectComponent: (id: string | null) => void;
  setHover: (id: string | null) => void;
  setDragging: (id: string | null) => void;
  toggleGrid: () => void;
  toggleGridOnline: () => void;  // Fix B3：电网在线/离线切换（独立于 gs_on；不与 toggleGrid 冲突）
  toggleCoords: () => void;
  toggleEditMode: () => void;
  toggleSnapToGrid: () => void;
  toggleSmartGuides: () => void;
  setGridSize: (size: number) => void;
  resetLayout: (defaults: Record<string, { x: number; y: number }>) => void;
  /** 恢复原理图默认拓扑：清理用户线缆/仪表拖拽，仅保留系统预置仪表。 */
  resetCanvasLayout: () => void;
  /** 新建空白设计图：保留标准部件和预置仪表，只清空线缆与用户布局。 */
  clearCanvasLayout: () => void;

  // 线缆 actions
  /** 从调色板拖出一条新线缆（两端可各带浮动坐标） */
  addCable: (
    kind: CableKind,
    fromAnchorId: string | null,
    toAnchorId: string | null,
    floatingFrom: { x: number; y: number } | null,
    floatingTo: { x: number; y: number } | null
  ) => string;
  /** 改变某段某端点吸附到新锚点（同时清掉对应浮动坐标） */
  updateCableEnd: (cableId: string, end: 'from' | 'to', anchorId: string | null) => void;
  /** 拖动端点时实时更新浮动坐标 */
  setCableFloating: (cableId: string, end: 'from' | 'to', pos: { x: number; y: number } | null) => void;
  /** 删除线缆（整条） */
  removeCable: (cableId: string) => void;
  selectCable: (cableId: string | null) => void;
  // M1.5 Round 9 新增：单线缆粒子动画开关 + 方向
  setCableAnimation: (cableId: string, enabled: boolean) => void;
  setCableDirectionMode: (cableId: string, mode: import('../data/cables').CableDirectionMode) => void;
  setCableRouteMode: (cableId: string, mode: CableRoutingMode) => void;
  setCableWaypoints: (cableId: string, points: Array<{ x: number; y: number }>) => void;

  // 仪表 actions
  /** 从调色板拖出仪表到画布（可带数据源绑定） */
  addMeter: (type: MeterType, position: { x: number; y: number }, bind?: MeterBind) => string;
  /** 移动仪表 */
  moveMeter: (id: string, position: { x: number; y: number }) => void;
  /** 修改仪表采集点绑定；undefined 表示显式未绑定。 */
  setMeterBind: (id: string, bind: MeterBind | undefined) => void;
  /** 删除仪表 */
  removeMeter: (id: string) => void;
  selectMeter: (id: string | null) => void;
  /** 全局线缆拖动状态 */
  setCableDrag: (
    drag: { cableId: string; end: 'from' | 'to'; pos: { x: number; y: number }; snapAnchorId: string | null } | null
  ) => void;

  /** 侧栏 / 全屏切换 */
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleFullscreen: () => void;

  /** 同步部件卡片画布像素位置（每次 cable drop / drag end 前调用） */
  setCardPositions: (
    positions: Record<string, { x: number; y: number; w: number; h: number }>
  ) => void;

  /** M2-α：记录数据注入元信息（不直接修改字段，由 ImportDataDialog 先 setState 再调用） */
  applyInjection: (data: { sourceFile: string; rowsCount: number }) => void;

  /** M2-β：保存完整采集数据集（含原始行 + 时间列），并重置回放到末尾 */
  setInjectionDataset: (data: {
    sourceFile: string;
    format: 'csv' | 'xlsx' | 'pdf';
    headers: string[];
    rows: Array<Record<string, string>>;
    timeColumn?: string;
    mapping?: Record<string, NumericFieldKey>;
    role?: InjectionSourceRole;
    sourceId?: string;
    /** 大屏批量导入已完成的共享整理结果，避免再次扫描和复制万级数据。 */
    prepared?: PreparedDataSource;
  }) => void;

  /** 清除数据集（恢复静态模式） */
  clearInjectionDataset: () => void;
  /** 仅移除指定来源；其它已导入来源继续保留。 */
  removeInjectionSource: (sourceId: string) => void;
  /** 替换当前回放会话来源集合，仅接受已导入 sourceId。 */
  setActivePlaybackSourceIds: (sourceIds: string[]) => void;
  /** 显式设置同步锚点与容差；无效锚点自动回退到当前首选来源。 */
  setPlaybackSessionConfig: (anchorSourceId: string | null, toleranceMs: number) => void;

  // M2-β 时序回放
  setTimelineIndex: (idx: number) => void;
  setTimelinePlaying: (playing: boolean) => void;
  setTimelineSpeed: (speed: number) => void;
  setTimelineMode: (mode: TimelineMode) => void;
  setTimelineCursorMs: (timestamp: number | null) => void;
  setInjectionFieldAvailability: (availability: Partial<Record<NumericFieldKey, boolean>>) => void;
  setPlaybackSnapshot: (snapshot: PlaybackSnapshot | null) => void;
  exitReplay: () => void;

  /** PCM 相变材料温度源切换（T0 / T1） */
  setPcmTempSelect: (sel: 'T0' | 'T1') => void;
}

/**
 * pv_on 是派生量，不是独立开关 —— 权威值是 pv_power。
 *
 * 证据链：
 *  - 控制面板只暴露「PV 功率」滑块，用户无法直接操作 pv_on；
 *  - setField('pv_power') / togglePv() / 10 个预设全部成对维护 `pv_on ⟺ pv_power > 0.01`；
 *  - 数据回放链路 services/schematicFrame.ts 也用 `setStatus('pv_on', power > 0.01)` 派生。
 * 因此凡是写 pv_power 的路径都必须同步派生 pv_on，否则会产出「有功率但光伏关闭」的矛盾存档。
 */
export const derivePvOn = (power: number): boolean => Math.abs(power) > 0.01;

function cloneDefaultCables(): Cable[] {
  return DEFAULT_CABLES.map((cable) => ({
    ...cable,
    segments: cable.segments.map((segment) => ({ ...segment })),
    floatingFrom: cable.floatingFrom ? { ...cable.floatingFrom } : null,
    floatingTo: cable.floatingTo ? { ...cable.floatingTo } : null,
    manualWaypoints: cable.manualWaypoints?.map((point) => ({ ...point })),
  }));
}

function clonePresetMeters(): MeterInstance[] {
  return PRESET_METERS.map((meter) => ({
    ...meter,
    position: { ...meter.position },
    presetVb: meter.presetVb ? { ...meter.presetVb } : undefined,
  }));
}

const DEFAULTS: SimulationState = {
  pv_power: 3.24, pv_sun: 0.6, bat_soc: 78,
  hp_temp: 24, hp_power: 3.2, tank_temp: 28, tank_volume: 65,
  tank_flow: 2.5, pump_flow: 2.5, at_temp: 24,
  pl_flow: 3.0, rl_flow: 2.5, wl_flow: 2.5,
  at_fan_speed: 3,
  pcm_temp: 28,
  load_power_kw: 0.62,
  battery_power_kw: 0,
  sac_water_level: 72,
  sac_water_temp: 18,
  sac_fan_speed: 0.75,
  sac_outlet_temp: 22,
  pv_on: true, cb_connected: true, gs_on: true,
  hp_on: true, pump_on: true, load_on: true, at_mode: 'cool',
  grid_online: true,
  sac_on: true,

  positions: {},
  selectedId: null,
  draggingId: null,
  hoverId: null,
  showGrid: true,
  showCoords: false,
  gridSize: 20,
  snapToGrid: true,
  smartGuides: true,
  editMode: false,

  animationOn: true,

  // 首次进入只展示标准部件和预置仪表；标准线缆由“标准拓扑”显式载入。
  cables: [],
  selectedCable: null,
  cableDrag: null,

  meters: clonePresetMeters(),
  selectedMeter: null,

  leftPanelOpen: false,   // 默认折叠（画布最大化）
  rightPanelOpen: false,  // 默认折叠
  fullscreen: false,

  cardPositions: {},
  lastInjection: null,
  injectionDataset: null,
  injectionSources: [],
  activePlaybackSourceIds: [],
  playbackAnchorSourceId: null,
  playbackToleranceMs: 2_000,
  timelineMode: 'combined',
  timelineCursorMs: null,
  injectionFieldAvailability: {},
  timelineIndex: -1,
  timelinePlaying: false,
  timelineSpeed: 120,
  controlMode: 'simulation',
  playbackSnapshot: null,
  pcm_temp_select: 'T0',
};

let _idCounter = 1000;
function genId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter}`;
}

/**
 * 解析 anchorId → 画布像素坐标（store 内部用，模拟 CircuitCanvas 的 getAnchorCanvasPos）
 * - 'inverter.right' 等组件锚点：读 cardPositions 卡片 rect 推算该边中点
 * - 'cable:X.Y' cable 引用：递归到目标端点
 * - '' 空：返回 null（调用方会 fallback）
 */
function resolveAnchorFallback(
  anchorId: string,
  cardPositions: Record<string, { x: number; y: number; w: number; h: number }>,
  cables: Cable[],
  visited: Set<string> = new Set(),
): { x: number; y: number } | null {
  // cycle 防护
  if (visited.has(anchorId)) return null;
  visited.add(anchorId);

  // cable: 引用 → 递归目标端点
  if (anchorId.startsWith('cable:')) {
    const m = anchorId.match(/^cable:(.+)\.(from|to)$/);
    if (!m) return null;
    const targetCable = cables.find((c) => c.id === m[1]);
    if (!targetCable || targetCable.segments.length === 0) return null;
    const isFrom = m[2] === 'from';
    const segIdx = isFrom ? 0 : targetCable.segments.length - 1;
    const inner = isFrom
      ? targetCable.segments[segIdx].fromAnchorId
      : targetCable.segments[segIdx].toAnchorId;
    if (inner) return resolveAnchorFallback(inner, cardPositions, cables, visited);
    // 目标端点是浮动端
    const fp = isFrom ? targetCable.floatingFrom : targetCable.floatingTo;
    return fp ?? null;
  }

  // 组件锚点 → 从 cardPositions 推算
  const m = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
  if (!m) return null;
  const card = cardPositions[m[1]];
  if (!card) return null;
  const cw = card.w;
  const ch = card.h;
  switch (m[2]) {
    case 'top':    return { x: card.x + cw / 2, y: card.y };
    case 'bottom': return { x: card.x + cw / 2, y: card.y + ch };
    case 'left':   return { x: card.x,           y: card.y + ch / 2 };
    case 'right':  return { x: card.x + cw,      y: card.y + ch / 2 };
  }
  return null;
}

export const useSimStore = create<SimStore>((set) => ({
  ...DEFAULTS,

  setField: (key, value) => set((s) => {
    const dataDriven = (s.injectionFieldAvailability as Record<string, boolean | undefined>)[key] === true;
    if (s.controlMode === 'replay' && dataDriven) return {};
    // 静态仿真不允许“显示有光伏功率、设备却处于关闭”的矛盾状态。
    if (key === 'pv_power' && s.controlMode === 'simulation') {
      const power = typeof value === 'number' ? value : 0;
      return { pv_power: power, pv_on: derivePvOn(power) };
    }
    return { [key]: value } as Partial<SimStore>;
  }),

  togglePv: () => set((s) => s.controlMode === 'replay' ? {} : s.pv_on
    ? ({ pv_on: false, pv_power: 0 })
    : ({ pv_on: true, pv_power: s.pv_power > 0.01 ? s.pv_power : DEFAULTS.pv_power })),
  toggleCb: () => set((s) => s.controlMode === 'replay' ? {} : ({ cb_connected: !s.cb_connected })),
  toggleGs: () => set((s) => s.controlMode === 'replay' ? {} : ({ gs_on: !s.gs_on })),
  toggleHp: () => set((s) => s.controlMode === 'replay' ? {} : ({ hp_on: !s.hp_on })),
  togglePump: () => set((s) => s.controlMode === 'replay' ? {} : ({ pump_on: !s.pump_on })),
  cycleAt: () => set((s) => s.controlMode === 'replay' ? {} : ({
    at_mode: s.at_mode === 'cool' ? 'heat' : (s.at_mode === 'heat' ? 'off' : 'cool'),
  })),
  toggleLoad: () => set((s) => s.controlMode === 'replay' ? {} : ({ load_on: !s.load_on })),  // Fix B6：原 cycleLoad 重命名
  toggleSolarAirCooler: () => set((s) => s.controlMode === 'replay' ? {} : ({ sac_on: !s.sac_on })),

  loadPreset: (name) => {
    if (useSimStore.getState().controlMode === 'replay') return;
    const p = PRESETS[name];
    if (!p) return;
    set((s) => ({ ...s, ...p }));
  },

  randomize: () => {
    if (useSimStore.getState().controlMode === 'replay') return;
    const jitter = (base: number, range: number) => base + (Math.random() - 0.5) * range;
    // 随机扰动只改数值不碰开关，会写出「pv_power≈4 但 pv_on=false」的矛盾存档，
    // 载入时又被 stateSerializer 的派生规则强行改回 true，造成"保存-打开后状态变了"。
    const pvPower = Math.max(0, jitter(3.5, 2));
    set({
      pv_power: pvPower, pv_on: derivePvOn(pvPower),
      pv_sun: Math.max(0, Math.min(1, jitter(0.6, 0.5))),
      bat_soc: jitter(70, 20),
      hp_temp: jitter(24, 4), hp_power: jitter(3.5, 2),
      tank_temp: jitter(40, 50), tank_volume: jitter(60, 30),
      tank_flow: jitter(2.5, 2), pump_flow: jitter(2.5, 2),
      at_temp: jitter(24, 3),
      sac_water_level: Math.max(0, Math.min(100, jitter(72, 36))),
      sac_water_temp: Math.max(0, Math.min(100, jitter(18, 24))),
      sac_fan_speed: Math.max(0, Math.min(1, jitter(0.75, 0.4))),
      sac_outlet_temp: Math.max(16, Math.min(35, jitter(22, 8))),
    });
  },

  // 仅复位仿真参数，不再顺带删除导入源、布局、线缆和仪表。
  resetAll: () => set((state) => state.controlMode === 'replay' ? {} : ({
    pv_power: DEFAULTS.pv_power,
    pv_sun: DEFAULTS.pv_sun,
    bat_soc: DEFAULTS.bat_soc,
    hp_temp: DEFAULTS.hp_temp,
    hp_power: DEFAULTS.hp_power,
    tank_temp: DEFAULTS.tank_temp,
    tank_volume: DEFAULTS.tank_volume,
    tank_flow: DEFAULTS.tank_flow,
    pump_flow: DEFAULTS.pump_flow,
    at_temp: DEFAULTS.at_temp,
    at_fan_speed: DEFAULTS.at_fan_speed,
    pcm_temp: DEFAULTS.pcm_temp,
    load_power_kw: DEFAULTS.load_power_kw,
    battery_power_kw: DEFAULTS.battery_power_kw,
    pl_flow: DEFAULTS.pl_flow,
    rl_flow: DEFAULTS.rl_flow,
    wl_flow: DEFAULTS.wl_flow,
    sac_water_level: DEFAULTS.sac_water_level,
    sac_water_temp: DEFAULTS.sac_water_temp,
    sac_fan_speed: DEFAULTS.sac_fan_speed,
    sac_outlet_temp: DEFAULTS.sac_outlet_temp,
    pv_on: DEFAULTS.pv_on,
    cb_connected: DEFAULTS.cb_connected,
    gs_on: DEFAULTS.gs_on,
    grid_online: DEFAULTS.grid_online,
    hp_on: DEFAULTS.hp_on,
    pump_on: DEFAULTS.pump_on,
    load_on: DEFAULTS.load_on,
    at_mode: DEFAULTS.at_mode,
    sac_on: DEFAULTS.sac_on,
  })),

  toggleAnimation: () => set((s) => ({ animationOn: !s.animationOn })),

  // === layout actions ===
  setPosition: (id, x, y) => set((s) => ({
    positions: {
      ...s.positions,
      [id]: { x, y },
    },
  })),
  setNodePositions: (updates) => set((s) => ({
    positions: {
      ...s.positions,
      ...Object.fromEntries(Object.entries(updates).filter(([id]) => !s.meters.some((m) => m.id === id))),
    },
    meters: s.meters.map((meter) => updates[meter.id]
      ? { ...meter, position: updates[meter.id], presetVb: undefined }
      : meter),
  })),

  selectComponent: (id) => set({ selectedId: id }),
  setHover: (id) => set({ hoverId: id }),
  setDragging: (id) => set({ draggingId: id }),

  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleGridOnline: () => set((s) => s.controlMode === 'replay' ? {} : ({ grid_online: !s.grid_online })),  // Fix B3
  toggleCoords: () => set((s) => ({ showCoords: !s.showCoords })),
  toggleEditMode: () => set((s) => ({ editMode: !s.editMode })),
  toggleSnapToGrid: () => set((s) => ({ snapToGrid: !s.snapToGrid })),
  toggleSmartGuides: () => set((s) => ({ smartGuides: !s.smartGuides })),
  setGridSize: (size) => set({ gridSize: Math.max(5, Math.min(100, size)) }),

  resetLayout: (defaults) => set({ positions: { ...defaults } }),
  resetCanvasLayout: () => set({
    positions: {},
    cables: cloneDefaultCables(),
    meters: clonePresetMeters(),
    selectedId: null,
    draggingId: null,
    hoverId: null,
    selectedCable: null,
    selectedMeter: null,
    cableDrag: null,
    cardPositions: {},
  }),
  clearCanvasLayout: () => set({
    positions: {},
    cables: [],
    meters: clonePresetMeters(),
    selectedId: null,
    draggingId: null,
    hoverId: null,
    selectedCable: null,
    selectedMeter: null,
    cableDrag: null,
    cardPositions: {},
  }),

  // === 线缆 actions ===
  addCable: (kind, fromAnchorId, toAnchorId, floatingFrom, floatingTo) => {
    const id = genId(kind);
    set((s) => {
      const newCable: Cable = {
        id,
        kind,
        segments: [{ fromAnchorId: fromAnchorId ?? '', toAnchorId: toAnchorId ?? '' }],
        floatingFrom: fromAnchorId ? null : floatingFrom,
        floatingTo: toAnchorId ? null : floatingTo,
        animationEnabled: true,
        // 新线缆保持用户绘制的 from→to 方向；之后只接受用户手动正向/反向控制。
        direction: 'forward',
        directionMode: 'forward',
        routeMode: 'orthogonal-auto',
      };
      return { cables: [...s.cables, newCable] };
    });
    return id;
  },

  updateCableEnd: (cableId, end, anchorId) => set((s) => {
    // ★ 智能保留连接：检测本端点是否被其他 cable 引用（"cable:THIS_CABLE.{from|to}"）
    const myRef = `${cableId}.${end}`;
    const isReferencedByOthers = s.cables.some((c) =>
      c.id !== cableId &&
      c.segments.some((seg) =>
        seg.fromAnchorId === `cable:${myRef}` || seg.toAnchorId === `cable:${myRef}`
      )
    );

    // 新 anchorId 性质判定：
    // - hasRealAnchor: 真实组件锚点（非空、非 cable 引用）
    // - isFloatingOrRef: 空字符串 或 cable 引用
    const newAnchorId = anchorId ?? '';
    const hasRealAnchor = newAnchorId !== '' && !newAnchorId.startsWith('cable:');

    // ★ 修复 3：被其它 cable 引用的端点不清 floating（避免破坏 cable-cable 连接）
    // 仅在 snap 到真组件锚点 且 没人引用本端点 时才清 floating
    const shouldClearFloating = hasRealAnchor && !isReferencedByOthers;

    return {
      cables: s.cables.map((c) => {
        if (c.id !== cableId) return c;
        const segs = c.segments.map((seg) => ({ ...seg }));
        if (segs.length === 0) return c;
        const oldAnchorId = end === 'from'
          ? segs[0].fromAnchorId
          : segs[segs.length - 1].toAnchorId;
        if (end === 'from') {
          segs[0].fromAnchorId = newAnchorId;
        } else {
          segs[segs.length - 1].toAnchorId = newAnchorId;
        }
        const next: Cable = { ...c, segments: segs };
        // ★ 仅在必要时清 floating（被其他 cable 引用的端点不清，避免破坏连接）
        if (shouldClearFloating) {
          if (end === 'from') (next as any).floatingFrom = null;
          else (next as any).floatingTo = null;
        } else if (newAnchorId === '' && oldAnchorId) {
          // ★ 兑底：清空 anchor 但 floating 仍为 null 时，用旧 anchor 解析坐标作为新 floating
          const anchorFallbackPos = resolveAnchorFallback(oldAnchorId, s.cardPositions, s.cables);
          // ★ 修复 2：兑底链兑不出来时，回落到 cable 自己的 floating（onMove 已写过一次）
          const ownFloatingPos = end === 'from' ? (c.floatingFrom ?? null) : (c.floatingTo ?? null);
          // 优先 anchor 解析（更新坐标），其次 ownFloatingPos（store 已是 CSS px）
          let cssPos: { x: number; y: number } | null = null;
          if (anchorFallbackPos) {
            cssPos = anchorFallbackPos;
          } else if (ownFloatingPos) {
            cssPos = ownFloatingPos;
          }
          if (cssPos) {
            if (end === 'from') (next as any).floatingFrom = cssPos;
            else (next as any).floatingTo = cssPos;
          }
        }
        return next;
      }),
    };
  }),

  // pos 入参为 CSS 像素（onMove 实时鼠标位置），直接写入。
  // pos=null 时直接置 null（拖拽取消时由 startDragEnd 的 onUp 路径调用）。
  setCableFloating: (cableId, end, pos) => set((s) => ({
    cables: s.cables.map((c) => {
      if (c.id !== cableId) return c;
      const next: Cable = { ...c };
      if (end === 'from') (next as any).floatingFrom = pos;
      else (next as any).floatingTo = pos;
      return next;
    }),
  })),

  removeCable: (cableId) => set((s) => {
    // 删除前保留被引用端点的屏幕坐标，避免支线突然缩成单点或消失。
    const removed = s.cables.find((cable) => cable.id === cableId);
    const removedFrom = removed
      ? resolveAnchorFallback(removed.segments[0]?.fromAnchorId ?? '', s.cardPositions, s.cables) ?? removed.floatingFrom ?? null
      : null;
    const removedTo = removed
      ? resolveAnchorFallback(removed.segments[removed.segments.length - 1]?.toAnchorId ?? '', s.cardPositions, s.cables) ?? removed.floatingTo ?? null
      : null;
    const preservedPoint = (anchorId: string) => anchorId === `cable:${cableId}.from` ? removedFrom : removedTo;
    const cleaned = s.cables.map((c) => {
      if (c.id === cableId) return c;
      let needsFix = false;
      let floatingFrom = c.floatingFrom;
      let floatingTo = c.floatingTo;
      const segs = c.segments.map((seg, segmentIndex) => {
        let from = seg.fromAnchorId;
        let to = seg.toAnchorId;
        if (from === `cable:${cableId}.from` || from === `cable:${cableId}.to`) {
          needsFix = true;
          if (segmentIndex === 0) floatingFrom = preservedPoint(from) ?? floatingFrom;
          from = '';
        }
        if (to === `cable:${cableId}.from` || to === `cable:${cableId}.to`) {
          needsFix = true;
          if (segmentIndex === c.segments.length - 1) floatingTo = preservedPoint(to) ?? floatingTo;
          to = '';
        }
        return { ...seg, fromAnchorId: from, toAnchorId: to };
      });
      if (!needsFix) return c;
      return { ...c, segments: segs, floatingFrom, floatingTo };
    });
    return {
      cables: cleaned.filter((c) => c.id !== cableId),
      selectedCable: s.selectedCable === cableId ? null : s.selectedCable,
      cableDrag: s.cableDrag?.cableId === cableId ? null : s.cableDrag,
    };
  }),

  selectCable: (cableId) => set({ selectedCable: cableId }),

  setCableAnimation: (cableId, enabled) =>
    set((s) => ({
      cables: s.cables.map((c) =>
        c.id === cableId ? { ...c, animationEnabled: enabled } : c
      ),
    })),

  setCableDirectionMode: (cableId, mode) =>
    set((s) => ({
      cables: s.cables.map((c) => c.id === cableId
        ? { ...c, directionMode: mode, direction: mode }
        : c),
    })),

  setCableRouteMode: (cableId, mode) => set((s) => ({
    cables: s.cables.map((cable) => cable.id === cableId
      ? {
          ...cable,
          routeMode: mode,
          manualWaypoints: mode === 'orthogonal-manual' ? cable.manualWaypoints : undefined,
        }
      : cable),
  })),

  setCableWaypoints: (cableId, points) => set((s) => ({
    cables: s.cables.map((cable) => cable.id === cableId
      ? { ...cable, routeMode: 'orthogonal-manual', manualWaypoints: points }
      : cable),
  })),

  setCableDrag: (drag) => set({ cableDrag: drag }),

  // === 侧栏 / 全屏切换 ===
  toggleLeftPanel: () => set((s) => ({
    leftPanelOpen: !s.leftPanelOpen,
    fullscreen: false,
  })),

  toggleRightPanel: () => set((s) => ({
    rightPanelOpen: !s.rightPanelOpen,
    fullscreen: false,
  })),

  toggleFullscreen: () => set((s) => {
    const next = !s.fullscreen;
    return {
      fullscreen: next,
      leftPanelOpen: next ? false : s.leftPanelOpen,
      rightPanelOpen: next ? false : s.rightPanelOpen,
    };
  }),

  setCardPositions: (positions) => set({ cardPositions: positions }),

  applyInjection: (data) =>
    set({
      lastInjection: {
        sourceFile: data.sourceFile,
        rowsCount: data.rowsCount,
        injectedAt: new Date().toISOString(),
      },
    }),

  setInjectionDataset: (data) =>
    set((state) => {
      const timeColumn = data.timeColumn ?? data.prepared?.timeStats.timeColumn ?? detectTimeColumn(data.headers, data.rows);
      const provisionalRole = data.role ?? detectSourceProfile(data.headers).kind;
      const provisionalId = data.sourceId ?? data.prepared?.id ?? `${provisionalRole}:${data.sourceFile}`;
      const prepared = data.prepared ?? prepareDataSource({
        id: provisionalId,
        filename: data.sourceFile,
        format: data.format,
        headers: data.headers,
        rows: data.rows,
        timeColumn,
      });
      const role = data.role ?? prepared.profile.kind;
      const sourceId = data.sourceId ?? prepared.id ?? `${role}:${data.sourceFile}`;
      const mapping = data.mapping ?? Object.fromEntries(
        data.headers.flatMap((header) => {
          const field = matchColumnToField(header);
          return field ? [[header, field]] : [];
        }),
      );
      const dataset: InjectionDataset = {
        ...data,
        sourceId,
        role,
        timeColumn,
        mapping: { ...mapping },
        headers: prepared.headers,
        rawRows: prepared.rows,
        rows: prepared.processedRows.filter((row) => row.valid).map((row) => row.raw),
        quality: prepared.quality,
        prepared: prepared.id === sourceId ? prepared : { ...prepared, id: sourceId },
        injectedAt: new Date().toISOString(),
      };
      const withoutSameSource = state.injectionSources.filter((source) => source.sourceId !== sourceId);
      const injectionSources = [...withoutSameSource, dataset];
      const activePlaybackSourceIds = [...new Set([
        ...state.activePlaybackSourceIds.filter((id) => injectionSources.some((source) => source.sourceId === id)),
        sourceId,
      ])];
      const preferred = role === 'thermal-electrical' || role === 'mixed'
        ? dataset
        : injectionSources.find((source) => source.role === 'thermal-electrical' || source.role === 'mixed') ?? dataset;
      const lastIndex = Math.max(0, preferred.rows.length - 1);
      const rawTime = preferred.timeColumn ? preferred.rows[lastIndex]?.[preferred.timeColumn] : undefined;
      return {
        injectionSources,
        activePlaybackSourceIds,
        playbackAnchorSourceId: activePlaybackSourceIds.includes(state.playbackAnchorSourceId ?? '')
          ? state.playbackAnchorSourceId
          : preferred.sourceId,
        injectionDataset: preferred,
        timelineIndex: lastIndex,
        timelineCursorMs: parseDatasetTime(rawTime),
        timelinePlaying: false,
        injectionFieldAvailability: {},
        controlMode: 'replay',
        playbackSnapshot: null,
      };
    }),

  clearInjectionDataset: () =>
    set({
      injectionDataset: null,
      injectionSources: [],
      activePlaybackSourceIds: [],
      playbackAnchorSourceId: null,
      timelineIndex: -1,
      timelineCursorMs: null,
      timelinePlaying: false,
      injectionFieldAvailability: {},
      controlMode: 'simulation',
      playbackSnapshot: null,
    }),

  removeInjectionSource: (sourceId) => set((state) => {
    const injectionSources = state.injectionSources.filter((source) => source.sourceId !== sourceId);
    if (!injectionSources.length) {
      return {
        injectionSources: [],
        activePlaybackSourceIds: [],
        playbackAnchorSourceId: null,
        injectionDataset: null,
        timelineIndex: -1,
        timelineCursorMs: null,
        timelinePlaying: false,
        injectionFieldAvailability: {},
        controlMode: 'simulation',
        playbackSnapshot: null,
      };
    }
    const removedActive = state.injectionDataset?.sourceId === sourceId;
    const preferred = removedActive
      ? injectionSources.find((source) => source.role === 'thermal-electrical' || source.role === 'mixed') ?? injectionSources[0]
      : state.injectionDataset;
    const timelineIndex = preferred?.rows.length ? 0 : -1;
    const rawTime = preferred?.timeColumn && timelineIndex >= 0
      ? preferred.rows[timelineIndex]?.[preferred.timeColumn]
      : undefined;
    const hasThermal = injectionSources.some((source) => source.role === 'thermal-electrical' || source.role === 'mixed');
    const hasBms = injectionSources.some((source) => source.role === 'battery-bms');
    const remainingActiveIds = state.activePlaybackSourceIds.filter((id) => id !== sourceId);
    const nextActiveIds = remainingActiveIds.length ? remainingActiveIds : preferred ? [preferred.sourceId] : [];
    return {
      injectionSources,
      activePlaybackSourceIds: nextActiveIds,
      playbackAnchorSourceId: nextActiveIds.includes(state.playbackAnchorSourceId ?? '')
        ? state.playbackAnchorSourceId
        : preferred?.sourceId ?? null,
      injectionDataset: preferred,
      timelineMode: state.timelineMode === 'combined' && !(hasThermal && hasBms)
        ? preferred?.role ?? 'generic'
        : state.timelineMode,
      timelineIndex,
      timelineCursorMs: parseDatasetTime(rawTime),
      timelinePlaying: false,
      injectionFieldAvailability: {},
      controlMode: 'replay',
      playbackSnapshot: null,
    };
  }),

  setActivePlaybackSourceIds: (sourceIds) => set((state) => {
    const available = new Map(state.injectionSources.map((source) => [source.sourceId, source]));
    const activePlaybackSourceIds = [...new Set(sourceIds.filter((id) => available.has(id)))];
    const selected = activePlaybackSourceIds.flatMap((id) => {
      const source = available.get(id);
      return source ? [source] : [];
    });
    const preferred = selected.find((source) => source.role === 'thermal-electrical' || source.role === 'mixed')
      ?? selected[0]
      ?? null;
    return {
      activePlaybackSourceIds,
      playbackAnchorSourceId: activePlaybackSourceIds.includes(state.playbackAnchorSourceId ?? '')
        ? state.playbackAnchorSourceId
        : preferred?.sourceId ?? null,
      injectionDataset: preferred,
      timelineIndex: preferred?.rows.length ? 0 : -1,
      timelineCursorMs: preferred?.timeColumn
        ? parseDatasetTime(preferred.rows[0]?.[preferred.timeColumn])
        : null,
      timelinePlaying: false,
      injectionFieldAvailability: preferred ? state.injectionFieldAvailability : {},
      controlMode: preferred ? state.controlMode : 'simulation',
      playbackSnapshot: null,
    };
  }),

  setPlaybackSessionConfig: (anchorSourceId, toleranceMs) => set((state) => {
    const active = new Set(state.activePlaybackSourceIds);
    const preferred = state.injectionSources.find((source) =>
      active.has(source.sourceId)
      && (source.role === 'thermal-electrical' || source.role === 'mixed'),
    ) ?? state.injectionSources.find((source) => active.has(source.sourceId));
    return {
      playbackAnchorSourceId: anchorSourceId && active.has(anchorSourceId)
        ? anchorSourceId
        : preferred?.sourceId ?? null,
      playbackToleranceMs: Math.max(0, Math.min(60_000, Math.round(toleranceMs))),
      timelinePlaying: false,
      playbackSnapshot: null,
    };
  }),

  setTimelineIndex: (idx) => set((s) => {
    const rows = s.injectionDataset?.rows;
    const maxIdx = rows ? rows.length - 1 : -1;
    const timelineIndex = Math.max(-1, Math.min(maxIdx, idx));
    const row = rows && timelineIndex >= 0 ? rows[timelineIndex] : undefined;
    const rawTime = s.injectionDataset?.timeColumn && row
      ? row[s.injectionDataset.timeColumn]
      : undefined;
    return {
      timelineIndex,
      timelineCursorMs: parseDatasetTime(rawTime) ?? s.timelineCursorMs,
    };
  }),

  setTimelinePlaying: (playing) => set({ timelinePlaying: playing }),

  setTimelineSpeed: (speed) => set({ timelineSpeed: speed }),

  setTimelineMode: (mode) => set((state) => {
    const role = mode === 'combined' ? 'thermal-electrical' : mode;
    const activeSources = state.injectionSources.filter((source) => state.activePlaybackSourceIds.includes(source.sourceId));
    const preferred = activeSources.find((source) => source.role === role)
      ?? state.injectionSources.find((source) => source.role === role)
      ?? (mode === 'combined' ? state.injectionSources.find((source) => source.role === 'mixed') : undefined)
      ?? state.injectionDataset
      ?? state.injectionSources[0]
      ?? null;
    const timelineIndex = preferred?.rows.length ? 0 : -1;
    const rawTime = preferred?.timeColumn && timelineIndex >= 0
      ? preferred.rows[timelineIndex]?.[preferred.timeColumn]
      : undefined;
    return {
      timelineMode: mode,
      injectionDataset: preferred,
      timelineIndex,
      timelineCursorMs: parseDatasetTime(rawTime),
      timelinePlaying: false,
      injectionFieldAvailability: {},
      controlMode: 'replay',
      playbackSnapshot: null,
    };
  }),

  setTimelineCursorMs: (timelineCursorMs) => set({ timelineCursorMs }),

  setInjectionFieldAvailability: (injectionFieldAvailability) =>
    set({ injectionFieldAvailability }),

  setPlaybackSnapshot: (playbackSnapshot) => set({
    playbackSnapshot,
    controlMode: playbackSnapshot ? 'replay' : 'simulation',
  }),

  exitReplay: () => set({
    controlMode: 'simulation',
    playbackSnapshot: null,
    timelinePlaying: false,
    injectionFieldAvailability: {},
  }),

  setPcmTempSelect: (sel) => set({ pcm_temp_select: sel }),

  // === 仪表 actions ===
  addMeter: (type, position, bind) => {
    const id = genId(type);
    set((s) => ({
      meters: [
        ...s.meters,
        { id, type, bind, mount: 'free', position },
      ],
    }));
    return id;
  },

  // 拖动仪表：position 入参为 CSS 像素（onMove 累加），清除 presetVb → 写入 CSS px。
  moveMeter: (id, position) => set((s) => ({
    meters: s.meters.map((m) =>
      m.id === id
        ? { ...m, position, presetVb: undefined }
        : m
    ),
  })),

  setMeterBind: (id, bind) => set((s) => ({
    meters: s.meters.map((meter) => meter.id === id ? { ...meter, bind } : meter),
  })),

  removeMeter: (id) => set((s) => {
    // Fix B5：删除仪表时为引用此 meter 的 cable 端点写入浮动坐标（避免 cable 渲染消失）
    const card = s.cardPositions[id];
    const clearedMeters = s.meters.filter((m) => m.id !== id);
    const clearedCables = s.cables.map((c) => {
      let needsFix = false;
      const segs = c.segments.map((seg) => {
        const fromMatch = seg.fromAnchorId.startsWith(`${id}.`);
        const toMatch = seg.toAnchorId.startsWith(`${id}.`);
        if (!fromMatch && !toMatch) return seg;
        needsFix = true;
        return {
          fromAnchorId: fromMatch ? '' : seg.fromAnchorId,
          toAnchorId: toMatch ? '' : seg.toAnchorId,
        };
      });
      if (!needsFix) return c;
      // 写入浮动坐标（卡片中心，CSS px）
      const fp = card ? { x: card.x + card.w / 2, y: card.y + card.h / 2 } : null;
      return {
        ...c,
        segments: segs,
        floatingFrom: fp ?? c.floatingFrom,
        floatingTo: fp ?? c.floatingTo,
      };
    });
    return {
      meters: clearedMeters,
      cables: clearedCables,
      selectedMeter: s.selectedMeter === id ? null : s.selectedMeter,
      selectedCable: s.selectedCable === id ? null : s.selectedCable,
      cardPositions: Object.fromEntries(
        Object.entries(s.cardPositions).filter(([k]) => k !== id)
      ) as Record<string, { x: number; y: number; w: number; h: number }>,
    };
  }),

  selectMeter: (id) => set({ selectedMeter: id, selectedCable: null }),
}));
