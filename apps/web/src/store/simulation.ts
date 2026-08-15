import { create } from 'zustand';
import { PRESETS } from '../data/presets';
import { CABLES as DEFAULT_CABLES, type Cable } from '../data/cables';
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
  battery_power_kw: number;  // Fix B2：电池功率（正=充电，负=放电，M2 引擎接入后由物理模型驱动）
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
  /** 回放倍速（1/2/4/8） */
  timelineSpeed: number;

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
  selectComponent: (id: string | null) => void;
  setHover: (id: string | null) => void;
  setDragging: (id: string | null) => void;
  toggleGrid: () => void;
  toggleGridOnline: () => void;  // Fix B3：电网在线/离线切换（独立于 gs_on；不与 toggleGrid 冲突）
  toggleCoords: () => void;
  toggleEditMode: () => void;
  resetLayout: (defaults: Record<string, { x: number; y: number }>) => void;
  /** 恢复原理图默认拓扑：清理用户线缆/仪表拖拽，仅保留系统预置仪表。 */
  resetCanvasLayout: () => void;

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
  toggleCableDirection: (cableId: string) => void;

  // 仪表 actions
  /** 从调色板拖出仪表到画布（可带数据源绑定） */
  addMeter: (type: MeterType, position: { x: number; y: number }, bind?: MeterBind) => string;
  /** 移动仪表 */
  moveMeter: (id: string, position: { x: number; y: number }) => void;
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
  }) => void;

  /** 清除数据集（恢复静态模式） */
  clearInjectionDataset: () => void;
  /** 仅移除指定来源；其它已导入来源继续保留。 */
  removeInjectionSource: (sourceId: string) => void;

  // M2-β 时序回放
  setTimelineIndex: (idx: number) => void;
  setTimelinePlaying: (playing: boolean) => void;
  setTimelineSpeed: (speed: number) => void;
  setTimelineMode: (mode: TimelineMode) => void;
  setTimelineCursorMs: (timestamp: number | null) => void;
  setInjectionFieldAvailability: (availability: Partial<Record<NumericFieldKey, boolean>>) => void;

  /** PCM 相变材料温度源切换（T0 / T1） */
  setPcmTempSelect: (sel: 'T0' | 'T1') => void;
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
  editMode: false,

  animationOn: true,

  cables: DEFAULT_CABLES.map((c) => ({ ...c, segments: c.segments.map((s) => ({ ...s })) })),
  selectedCable: null,
  cableDrag: null,

  meters: PRESET_METERS.map((m) => ({ ...m, position: { ...m.position } })),
  selectedMeter: null,

  leftPanelOpen: false,   // 默认折叠（画布最大化）
  rightPanelOpen: false,  // 默认折叠
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
  timelineSpeed: 1,
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

  setField: (key, value) => set((s) => ({ ...s, [key]: value })),

  togglePv: () => set((s) => ({ pv_on: !s.pv_on })),
  toggleCb: () => set((s) => ({ cb_connected: !s.cb_connected })),
  toggleGs: () => set((s) => ({ gs_on: !s.gs_on })),
  toggleHp: () => set((s) => ({ hp_on: !s.hp_on })),
  togglePump: () => set((s) => ({ pump_on: !s.pump_on })),
  cycleAt: () => set((s) => ({
    at_mode: s.at_mode === 'cool' ? 'heat' : (s.at_mode === 'heat' ? 'off' : 'cool'),
  })),
  toggleLoad: () => set((s) => ({ load_on: !s.load_on })),  // Fix B6：原 cycleLoad 重命名
  toggleSolarAirCooler: () => set((s) => ({ sac_on: !s.sac_on })),

  loadPreset: (name) => {
    const p = PRESETS[name];
    if (!p) return;
    set((s) => ({ ...s, ...p }));
  },

  randomize: () => {
    const jitter = (base: number, range: number) => base + (Math.random() - 0.5) * range;
    set({
      pv_power: jitter(3.5, 2), pv_sun: Math.max(0, Math.min(1, jitter(0.6, 0.5))),
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

  resetAll: () => set({ ...DEFAULTS }),

  toggleAnimation: () => set((s) => ({ animationOn: !s.animationOn })),

  // === layout actions ===
  setPosition: (id, x, y) => set((s) => ({
    positions: {
      ...s.positions,
      [id]: { x, y },
    },
  })),

  selectComponent: (id) => set({ selectedId: id }),
  setHover: (id) => set({ hoverId: id }),
  setDragging: (id) => set({ draggingId: id }),

  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleGridOnline: () => set((s) => ({ grid_online: !s.grid_online })),  // Fix B3
  toggleCoords: () => set((s) => ({ showCoords: !s.showCoords })),
  toggleEditMode: () => set((s) => ({ editMode: !s.editMode })),

  resetLayout: (defaults) => set({ positions: { ...defaults } }),
  resetCanvasLayout: () => set({
    positions: {},
    cables: DEFAULT_CABLES.map((c) => ({ ...c, segments: c.segments.map((s) => ({ ...s })) })),
    meters: PRESET_METERS.map((m) => ({
      ...m,
      position: { ...m.position },
      presetVb: m.presetVb ? { ...m.presetVb } : undefined,
    })),
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
        direction: Math.random() < 0.5 ? 'forward' : 'reverse',
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
    // Fix B4：清理其它 cable 中引用本 cable 端点的 segments（防止悬空 cable:X.from/to 引用）
    const cleaned = s.cables.map((c) => {
      if (c.id === cableId) return c;
      let needsFix = false;
      const segs = c.segments.map((seg) => {
        let from = seg.fromAnchorId;
        let to = seg.toAnchorId;
        if (from === `cable:${cableId}.from` || from === `cable:${cableId}.to`) {
          needsFix = true;
          from = '';
        }
        if (to === `cable:${cableId}.from` || to === `cable:${cableId}.to`) {
          needsFix = true;
          to = '';
        }
        return { ...seg, fromAnchorId: from, toAnchorId: to };
      });
      if (!needsFix) return c;
      return { ...c, segments: segs };
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

  toggleCableDirection: (cableId) =>
    set((s) => ({
      cables: s.cables.map((c) => {
        if (c.id !== cableId) return c;
        // ★ fallback 'forward'：旧 cable 无 direction 字段时第一次点击也能切到 'reverse'
        const currentDir = c.direction ?? 'forward';
        return { ...c, direction: currentDir === 'forward' ? 'reverse' : 'forward' };
      }),
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
      const timeColumn = data.timeColumn ?? detectTimeColumn(data.headers, data.rows);
      const provisionalRole = data.role ?? detectSourceProfile(data.headers).kind;
      const provisionalId = data.sourceId ?? `${provisionalRole}:${data.sourceFile}`;
      const prepared = prepareDataSource({
        id: provisionalId,
        filename: data.sourceFile,
        format: data.format,
        headers: data.headers,
        rows: data.rows,
        timeColumn,
      });
      const role = data.role ?? prepared.profile.kind;
      const sourceId = data.sourceId ?? `${role}:${data.sourceFile}`;
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
        headers: [...data.headers],
        rawRows: prepared.rows.map((row) => ({ ...row })),
        rows: prepared.processedRows.filter((row) => row.valid).map((row) => ({ ...row.raw })),
        quality: prepared.quality,
        prepared: { ...prepared, id: sourceId },
        injectedAt: new Date().toISOString(),
      };
      const withoutSameSource = state.injectionSources.filter((source) => source.sourceId !== sourceId);
      const injectionSources = [...withoutSameSource, dataset];
      const preferred = role === 'thermal-electrical' || role === 'mixed'
        ? dataset
        : injectionSources.find((source) => source.role === 'thermal-electrical' || source.role === 'mixed') ?? dataset;
      const lastIndex = Math.max(0, preferred.rows.length - 1);
      const rawTime = preferred.timeColumn ? preferred.rows[lastIndex]?.[preferred.timeColumn] : undefined;
      return {
        injectionSources,
        injectionDataset: preferred,
        timelineIndex: lastIndex,
        timelineCursorMs: parseDatasetTime(rawTime),
        timelinePlaying: false,
        injectionFieldAvailability: {},
      };
    }),

  clearInjectionDataset: () =>
    set({
      injectionDataset: null,
      injectionSources: [],
      timelineIndex: -1,
      timelineCursorMs: null,
      timelinePlaying: false,
      injectionFieldAvailability: {},
    }),

  removeInjectionSource: (sourceId) => set((state) => {
    const injectionSources = state.injectionSources.filter((source) => source.sourceId !== sourceId);
    if (!injectionSources.length) {
      return {
        injectionSources: [],
        injectionDataset: null,
        timelineIndex: -1,
        timelineCursorMs: null,
        timelinePlaying: false,
        injectionFieldAvailability: {},
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
    return {
      injectionSources,
      injectionDataset: preferred,
      timelineMode: state.timelineMode === 'combined' && !(hasThermal && hasBms)
        ? preferred?.role ?? 'generic'
        : state.timelineMode,
      timelineIndex,
      timelineCursorMs: parseDatasetTime(rawTime),
      timelinePlaying: false,
      injectionFieldAvailability: {},
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
    const preferred = state.injectionSources.find((source) => source.role === role)
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
    };
  }),

  setTimelineCursorMs: (timelineCursorMs) => set({ timelineCursorMs }),

  setInjectionFieldAvailability: (injectionFieldAvailability) =>
    set({ injectionFieldAvailability }),

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
