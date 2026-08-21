import type { Cable } from '../data/cables';
import type { SimulationState } from '../store/simulation';
import { derivePcmVisual, type PcmVisual } from './pcm';

export type InverterMode = 'dc-to-ac' | 'ac-to-dc' | 'idle';
export type StaticBatteryMode = 'charging' | 'discharging' | 'idle';
export interface CableSegmentFlow {
  active: boolean;
  direction: 'forward' | 'reverse';
  /** 屏幕像素/秒；动画层按 zoom 换算成世界距离。 */
  pixelsPerSecond: number;
  reason: 'flowing' | 'disabled' | 'status-off' | 'data-unavailable' | 'zero-flow';
}

const POWER_EPSILON_KW = 0.01;

/**
 * 静态仿真统一约定：电池功率正值=放电，负值=充电。
 * BMS 原始电流的正负约定仍由数据分析配置单独解释，不能复用本函数。
 */
export function deriveStaticBatteryMode(powerKw: number): StaticBatteryMode {
  if (powerKw > POWER_EPSILON_KW) return 'discharging';
  if (powerKw < -POWER_EPSILON_KW) return 'charging';
  return 'idle';
}

export function deriveStaticBatteryFlowDirection(powerKw: number): 'in' | 'out' | 'idle' {
  const mode = deriveStaticBatteryMode(powerKw);
  return mode === 'charging' ? 'in' : mode === 'discharging' ? 'out' : 'idle';
}

/**
 * 逆变器模式不再借用末端冷热模式：
 * - 有 PV 输入或电池放电时为 DC→AC；
 * - 无直流供电、但电网在线且电池正在充电时为 AC→DC；
 * - 其它情况待机。
 */
export function deriveInverterMode(state: Pick<SimulationState,
  'pv_on' | 'cb_connected' | 'pv_power' | 'grid_online' | 'gs_on' | 'battery_power_kw'
>): InverterMode {
  const hasPvInput = state.pv_on && state.cb_connected && state.pv_power > POWER_EPSILON_KW;
  const batteryMode = deriveStaticBatteryMode(state.battery_power_kw);
  if (hasPvInput || batteryMode === 'discharging') return 'dc-to-ac';
  if (state.grid_online && state.gs_on && batteryMode === 'charging') return 'ac-to-dc';
  return 'idle';
}

export function fanSpeedLabel(speed: number, mode: SimulationState['at_mode']): string {
  if (mode === 'off' || speed <= 0) return '停';
  const level = Math.max(1, Math.min(4, Math.round(speed)));
  return ['停', '低', '中', '高', '强'][level];
}

/** 采集会话下优先使用当前选中的 T0/T1 实测值驱动 PCM 相态。 */
export function deriveSelectedPcmVisual(
  state: Pick<SimulationState, 'tank_temp' | 'pump_on' | 'pump_flow' | 'pcm_temp'>,
  selectedLiveTemp: number | null,
): PcmVisual {
  return derivePcmVisual({
    ...state,
    pcm_temp: selectedLiveTemp ?? state.pcm_temp,
  });
}

function directComponentIds(cable: Cable): Set<string> {
  const ids = new Set<string>();
  for (const segment of cable.segments) {
    for (const anchorId of [segment.fromAnchorId, segment.toAnchorId]) {
      if (!anchorId || anchorId.startsWith('cable:')) continue;
      const match = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
      if (match) ids.add(match[1]);
    }
  }
  return ids;
}

function endpointComponentId(anchorId: string, cables: Cable[], seen = new Set<string>()): string | null {
  if (!anchorId) return null;
  const direct = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
  if (direct && !anchorId.startsWith('cable:')) return direct[1];
  const reference = anchorId.match(/^cable:(.+)\.(from|to)$/);
  if (!reference || seen.has(reference[1])) return null;
  const referenced = cables.find((item) => item.id === reference[1]);
  if (!referenced?.segments.length) return null;
  const nested = reference[2] === 'from'
    ? referenced.segments[0].fromAnchorId
    : referenced.segments[referenced.segments.length - 1].toAnchorId;
  return endpointComponentId(nested, cables, new Set(seen).add(referenced.id));
}

const COMPONENT_STATUS: Partial<Record<string, keyof NonNullable<SimulationState['playbackSnapshot']>['statusAvailability']>> = {
  'pv-array': 'pv_on', 'combiner-box': 'cb_connected', grid: 'grid_online',
  'grid-switch': 'gs_on', load: 'load_on', 'heat-pump': 'hp_on', pump: 'pump_on',
  'air-terminal': 'at_mode',
};

function componentEnabled(id: string | null, state: SimulationState): boolean | null {
  if (!id) return true;
  const statusKey = COMPONENT_STATUS[id];
  if (state.controlMode === 'replay' && statusKey
    && state.playbackSnapshot?.statusAvailability[statusKey] !== true) {
    // CB/GS 遥信并不在当前采集文件中；未知不等于明确分闸。
    if (id === 'combiner-box') return true;
    if (id === 'grid-switch') {
      return state.playbackSnapshot?.statusAvailability.grid_online === true
        ? state.grid_online
        : null;
    }
    return null;
  }
  if (id === 'pv-array') return state.pv_on;
  if (id === 'combiner-box') return state.cb_connected;
  if (id === 'grid') return state.grid_online;
  if (id === 'grid-switch') return state.grid_online && state.gs_on;
  if (id === 'load') return state.load_on;
  if (id === 'heat-pump') return state.hp_on;
  if (id === 'pump') return state.pump_on;
  if (id === 'air-terminal') return state.at_mode !== 'off';
  if (id === 'solar-air-cooler') return state.sac_on;
  return true;
}

/**
 * 自动方向只采用能够明确解释的设备语义。
 * KCL 等效网络仍用于流量大小，但不再用单位阻抗解的符号随意翻转视觉方向。
 * 返回 null 时沿用用户创建线缆时的 from→to 方向。
 */
export function deriveSemanticPowerDirection(
  fromId: string | null,
  toId: string | null,
  state: SimulationState,
): 'forward' | 'reverse' | null {
  const replayValues = state.controlMode === 'replay' ? state.playbackSnapshot?.values : null;
  const batteryPower = replayValues?.battery_voltage != null && replayValues?.battery_current != null
    ? -(replayValues.battery_voltage * replayValues.battery_current) / 1000
    : state.controlMode === 'replay' ? null : state.battery_power_kw;

  // 双向电池优先级最高：充电必须朝向电池，放电必须背离电池。
  if ((fromId === 'battery' || toId === 'battery') && batteryPower != null
    && Math.abs(batteryPower) > POWER_EPSILON_KW) {
    const batteryIsFrom = fromId === 'battery';
    const awayFromBattery = batteryPower > 0;
    return batteryIsFrom === awayFromBattery ? 'forward' : 'reverse';
  }
  // 光伏只作为电源，方向始终背离光伏阵列。
  if (fromId === 'pv-array') return 'forward';
  if (toId === 'pv-array') return 'reverse';
  // 负载与热泵只作为用电端，方向始终流入设备。
  const consumer = (id: string | null) => id === 'load' || id === 'heat-pump';
  if (consumer(fromId)) return 'reverse';
  if (consumer(toId)) return 'forward';
  return null;
}

/** 当前 segment 的通流、方向和速度唯一派生入口。 */
export function deriveCableSegmentFlow(cable: Cable, segmentIndex: number, state: SimulationState): CableSegmentFlow {
  if (cable.animationEnabled === false) {
    return { active: false, direction: cable.direction, pixelsPerSecond: 0, reason: 'disabled' };
  }
  const segment = cable.segments[segmentIndex];
  if (!segment) return { active: false, direction: cable.direction, pixelsPerSecond: 0, reason: 'data-unavailable' };
  const direction = cable.directionMode === 'reverse'
    || (cable.directionMode === 'auto' && cable.direction === 'reverse') ? 'reverse' : 'forward';
  const configuredFlow = cable.kind === 'power' ? state.pl_flow
    : cable.kind === 'refrigerant' ? state.rl_flow
    : state.wl_flow;
  // 动画开启就是明确的人工指令；速度滑块仅调速，不再决定线路是否有动画。
  const speedBase = Number.isFinite(configuredFlow) ? Math.max(1, configuredFlow) : 1;
  return {
    active: true,
    direction,
    pixelsPerSecond: Math.min(180, 28 + speedBase * 22),
    reason: 'flowing',
  };
}

/** 直接连接到已断开的部件时，线缆不得继续显示流动粒子。 */
export function isCableEnergized(cable: Cable, state: SimulationState): boolean {
  const ids = directComponentIds(cable);
  if (ids.has('pv-array') && !state.pv_on) return false;
  if (ids.has('combiner-box') && !state.cb_connected) return false;
  if (ids.has('grid') && !state.grid_online) return false;
  if (ids.has('grid-switch') && (!state.grid_online || !state.gs_on)) return false;
  if (ids.has('load') && !state.load_on) return false;
  if (ids.has('heat-pump') && !state.hp_on) return false;
  if (ids.has('air-terminal') && state.at_mode === 'off') return false;
  if (ids.has('solar-air-cooler') && !state.sac_on) return false;
  return true;
}

/** 按线缆所连负载/电源选择更贴近拓扑的功率基值，结果归一化到约 0..1。 */
export function powerCableBaseFlow(cable: Cable, state: SimulationState): number {
  if (!isCableEnergized(cable, state)) return 0;
  const ids = directComponentIds(cable);
  if (ids.has('battery')) return Math.abs(state.battery_power_kw) / 3;
  if (ids.has('load')) return state.load_power_kw / 3;
  if (ids.has('heat-pump')) return state.hp_power / 8;
  return state.pv_power / 6;
}
