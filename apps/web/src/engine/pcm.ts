// PCM 相变材料 · 视觉派生层 v0.4（M1 纯函数，无定时器）
// 未来部件联动引擎只需替换本函数内部实现，输出接口不变
//
// 物理背景：
//   - pcm_temp 0~50℃ 映射到 melt 0~1（0=全固态，1=全液态）
//   - 25℃ 为相变平台（潜热交换温度不变）
//   - 过渡时长：泵开 clamp(8/pump_flow, 1.5, 8) 上限 8s；泵停固定 30s（视觉冻结）
//   - v0.4 色带：紫蓝→紫→紫红→橙→黄→浅黄白（冷→暖，符合"冰↔火"直觉）
//   - v0.4 6 个 hex 视觉：scale 1→0.5 残影 + opacity 1→0.15 淡出，永远不消失
//   - v0.4 液面：scaleY=melt 线性（无 0.5 阈值阶梯）
//   - 引擎 7 字段：melt / phase / tempText / meltText / statusText / color / transitionSec

export type PcmPhase = 'solid' | 'melting' | 'liquid' | 'freezing';

export interface PcmVisual {
  /** 融化比例 0~1（0=全固态，1=全液态），驱动 --pcm-melt 与色带插值 */
  melt: number;
  /** 相态：solid 固态 / melting 融化中·蓄热 / liquid 液态 / freezing 凝固中·释热 */
  phase: PcmPhase;
  /** 温度读数：固态钳 ≤24℃、液态钳 ≥26℃、相变平台期固定 25.0℃ */
  tempText: string;
  /** 融化比例读数（百分比整数 + '%'） */
  meltText: string;
  /** 状态文字：固态 / 蓄热中 / 液态 / 释热中 */
  statusText: string;
  /** 状态灯 / 光晕 / 状态文字颜色（v18 反转：solid 橙, melting 蓝, liquid 浅蓝, freezing 暖橙） */
  color: string;
  /** 融化比例动画过渡时长（秒）：v18 修复后 ≤ 5s（含泵停） */
  transitionSec: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function derivePcmVisual(input: {
  tank_temp: number;
  pump_on: boolean;
  pump_flow: number;
  pcm_temp: number;
}): PcmVisual {
  const { pump_on, pump_flow, pcm_temp } = input;

  // 融化比例：pcm_temp 0~50℃ 线性映射到 0~1（0=全固态，1=全液态）
  const melt = clamp01(pcm_temp / 50);

  // 相态判定：端点滞回带 0.02/0.98 避免边界抖动；中间段按 PCM 温度分融化（≥25℃）/凝固（<25℃）
  const phase: PcmPhase =
    melt <= 0.02 ? 'solid'
    : melt >= 0.98 ? 'liquid'
    : pcm_temp >= 25 ? 'melting'
    : 'freezing';

  // 温度读数：相变平台期固定 25.0℃（潜热交换温度不变）；纯固/纯液显示真实温度但向平台钳位
  const tempText =
    phase === 'solid' ? Math.min(pcm_temp, 24).toFixed(1) + '℃'
    : phase === 'liquid' ? Math.max(pcm_temp, 26).toFixed(1) + '℃'
    : '25.0℃';

  const meltText = Math.round(melt * 100) + '%';

  const statusText =
    phase === 'solid' ? '固态'
    : phase === 'melting' ? '蓄热·恒温25℃'
    : phase === 'liquid' ? '液态'
    : '释热·恒温25℃';

  const color =
    phase === 'solid' ? '#38BDF8'    // 蓝（冷态）
    : phase === 'melting' ? '#F97316' // 橙（升温）
    : phase === 'liquid' ? '#FBBF24'  // 黄（热态）
    : '#3B82F6';                       // 深蓝（释热）

  // v0.4 原版：泵开上限 8s（视觉过渡更柔和），泵停固定 30s（冻结等待水温回归）
  const transitionSec = pump_on && pump_flow > 0
    ? Math.max(1.5, Math.min(8, 8 / pump_flow))
    : 30;

  return { melt, phase, tempText, meltText, statusText, color, transitionSec };
}
