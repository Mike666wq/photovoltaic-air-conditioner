// PCM 相变材料 · 视觉派生层 v0.4（M1 纯函数，无定时器）
// 未来部件联动引擎只需替换本函数内部实现，输出接口不变
//
// 物理背景：
//   - pcm_temp 0~50℃ 映射到 melt 0~1（0=全固态，1=全液态）
//   - 温度读数始终显示实测值：相变平台是物理概念，不能用一个常数冒充测量结果
//   - 状态文字只描述相态（潜热吸收/释放），不断言具体温度
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
  /** 温度读数：恒为实测 pcm_temp（一位小数 + ℃），不做任何钳位或平台期伪造 */
  tempText: string;
  /** 融化比例读数（百分比整数 + '%'） */
  meltText: string;
  /** 状态文字：固态 / 蓄热·相变区 / 液态 / 释热·相变区（只说相态，不报温度） */
  statusText: string;
  /** 状态灯 / 光晕 / 状态文字颜色（v18 反转：solid 橙, melting 蓝, liquid 浅蓝, freezing 暖橙） */
  color: string;
  /** 融化比例动画过渡时长（秒）：v18 修复后 ≤ 5s（含泵停） */
  transitionSec: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function derivePcmVisual(input: {
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

  // 温度读数：始终是实测值。
  // 历史实现把 pcm_temp∈(1,49) 整段当成"相变平台"并恒定输出 25.0℃，
  // 导致 94% 量程显示同一个假数（实测 8.6/9.8/12.4℃ 也被显示成 25.0℃）。
  // 平台期是潜热吸收/释放的物理现象，不等于"温度计读数恒为 25℃"；
  // 若某材料确有恒温平台，应在 melt 映射里体现，而不是篡改读数。
  const tempText = pcm_temp.toFixed(1) + '℃';

  const meltText = Math.round(melt * 100) + '%';

  // 相态文字只描述潜热方向，不掺入具体温度（实测 10℃ 时写"释热·恒温25℃"物理上自相矛盾）
  const statusText =
    phase === 'solid' ? '固态'
    : phase === 'melting' ? '蓄热·相变区'
    : phase === 'liquid' ? '液态'
    : '释热·相变区';

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
