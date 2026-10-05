import { useNativeForeground } from '../services/clientForeground';
import { useEffect, useRef, type RefObject } from 'react';
import { useSimStore } from '../store/simulation';

type StateKey = 'gs_on' | 'cb_connected';

/**
 * 部件状态切换瞬时高亮（电火花 / 闪烁反馈）。
 *
 * - 订阅 stateKey 的布尔变化（true→false 或 false→true）。
 * - 找到 svgRef 当前 DOM 内的 selector 元素，设 display:block。
 * - durationMs 后恢复 display:none。
 * - 多次快速切换：上一次 timeout 随 effect cleanup 自动 clear（只显示最新一次）。
 * - selector 在当前 SVG 内不存在（非目标部件）→ 静默 no-op。
 * - 初次挂载不触发（仅在 flag 实际发生变化时才触发，避免冷启动闪烁）。
 */
export function useTransientSpark(
  svgRef: RefObject<SVGSVGElement>,
  stateKey: StateKey,
  selector: string,
  durationMs = 800,
) {
  const flag = useSimStore((s) => s[stateKey]);
  const foreground = useNativeForeground();
  const animationOn = useSimStore((s) => s.animationOn) && foreground;
  const flagRef = useRef(flag);

  useEffect(() => {
    if (flagRef.current === flag) return;
    flagRef.current = flag;

    // 暂停时不触发点击瞬时反馈（统一开关逻辑）
    if (!animationOn) return;

    const svg = svgRef.current;
    if (!svg) return;
    const el = svg.querySelector<HTMLElement>(selector);
    if (!el) return;

    el.style.display = 'block';
    const id = setTimeout(() => {
      el.style.display = 'none';
    }, durationMs);

    // 必须同时复位 display：只 clearTimeout 会让火花永久停在显示态。
    // 触发路径：切换 gs_on/cb_connected 后 800ms 内再点一次动画开关 →
    // cleanup 清掉定时器 → 新 effect 首行 early-return → display 永远是 block，
    // 且 injectAll 不覆盖 inline style，只能靠重新 clone SVG 才恢复。
    return () => {
      clearTimeout(id);
      el.style.display = 'none';
    };
  }, [flag, svgRef, selector, durationMs, animationOn]);
}
