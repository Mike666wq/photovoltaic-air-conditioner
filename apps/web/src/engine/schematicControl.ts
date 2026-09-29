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
  // tank_temp 不参与 PCM 派生：相变是材料自身属性，水箱温度只驱动 tank.svg。
  // 早前这里透传 tank_temp，而 derivePcmVisual 从不读取它，属于无效耦合。
  state: Pick<SimulationState, 'pump_on' | 'pump_flow' | 'pcm_temp'>,
  selectedLiveTemp: number | null,
): PcmVisual {
  return derivePcmVisual({
    pump_on: state.pump_on,
    pump_flow: state.pump_flow,
    pcm_temp: selectedLiveTemp ?? state.pcm_temp,
  });
}

/** 当前 segment 的通流、方向和速度唯一派生入口。 */
export function deriveCableSegmentFlow(cable: Cable, segmentIndex: number, state: SimulationState): CableSegmentFlow {
  if (cable.animationEnabled === false) {
    return { active: false, direction: cable.direction, pixelsPerSecond: 0, reason: 'disabled' };
  }
  const segment = cable.segments[segmentIndex];
  if (!segment) return { active: false, direction: cable.direction, pixelsPerSecond: 0, reason: 'data-unavailable' };
  const direction = cable.directionMode ?? cable.direction ?? 'forward';
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
