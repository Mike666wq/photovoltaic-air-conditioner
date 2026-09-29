import {
  DEFAULT_BATTERY_CURRENT_CONVENTION,
  type BatteryCurrentConvention,
} from '../store/analysis';

/**
 * 电池功率符号的唯一换算入口。
 *
 * 背景：系统里存在两种"约定"，此前各自散落在多处硬编码：
 *  - 用户口径（store/analysis.batteryCurrentConvention）：描述 BMS 原始电流的正负号代表什么；
 *  - 原理图内部口径（engine/schematicControl.deriveStaticBatteryMode）：battery_power_kw 正=放电、负=充电。
 *
 * 之前 schematicFrame.ts 与 powerFlow.ts 都直接写死 `-(V*I)/1000`，
 * 等于把"用户口径恒为 positive-charge"写死了。用户在大屏切换口径时，
 * 原理图的电池状态文字跟随（走 CircuitCanvas 的 batteryDirection），
 * 但这两处派生值不跟随 —— 同一物理量出现两套符号来源。
 *
 * 统一到本函数后：用户口径是唯一输入，内部口径是唯一输出。
 * 'unknown' 不猜测方向，返回 null（调用方按"数据不可用"处理）。
 */
export function toSchematicBatteryPowerKw(
  voltage: number | undefined,
  current: number | undefined,
  convention: BatteryCurrentConvention = DEFAULT_BATTERY_CURRENT_CONVENTION,
): number | null {
  if (convention === 'unknown') return null;
  if (voltage == null || current == null) return null;
  if (!Number.isFinite(voltage) || !Number.isFinite(current)) return null;
  // electrical 遵循用户口径：positive-charge 时正值代表充电
  const electrical = (voltage * current) / 1000;
  // 换到原理图内部口径（正=放电）
  return convention === 'positive-charge' ? -electrical : electrical;
}
