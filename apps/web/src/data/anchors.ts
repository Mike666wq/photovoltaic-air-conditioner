// 14 部件 × 4 边 = 56 个组件锚点（部件中心 → 4 边中点的偏移）
// 每个部件 viewBox 240×240，按部件 scale 计算实际偏移

import { COMPONENTS } from './components';

export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

export interface ComponentAnchor {
  id: string;           // "pv-array.top"
  componentId: string;
  side: AnchorSide;
  /** 相对部件中心的偏移（部件已 scale 后的实际尺寸） */
  offset: { x: number; y: number };
}

/** 部件 viewBox 半宽 = 120，按 scale 缩放后得边中点偏移 */
function sideOffset(side: AnchorSide, scale: number): { x: number; y: number } {
  const h = 120 * scale;
  switch (side) {
    case 'top':    return { x: 0,    y: -h };
    case 'bottom': return { x: 0,    y:  h };
    case 'left':   return { x: -h,   y: 0  };
    case 'right':  return { x:  h,   y: 0  };
  }
}

/** 56 个组件锚点（按部件顺序展开） */
export const COMPONENT_ANCHORS: ComponentAnchor[] = COMPONENTS.flatMap((c) =>
  (['top', 'bottom', 'left', 'right'] as AnchorSide[]).map((side) => ({
    id: `${c.id}.${side}`,
    componentId: c.id,
    side,
    offset: sideOffset(side, c.scale),
  }))
);

/** 锚点 id → 组件锚点定义 */
export function findComponentAnchor(id: string): ComponentAnchor | null {
  return COMPONENT_ANCHORS.find((a) => a.id === id) ?? null;
}

/** 锚点 → 绝对画布坐标（跟随部件当前位置） */
export function getAnchorPosition(
  anchorId: string,
  positions: Record<string, { x: number; y: number }>
): { x: number; y: number } | null {
  const a = findComponentAnchor(anchorId);
  if (!a) return null;
  const c = COMPONENTS.find((x) => x.id === a.componentId);
  if (!c) return null;
  const pos = positions[c.id] ?? { x: c.x, y: c.y };
  // 部件中心 = (pos.x + 120*scale, pos.y + 120*scale)
  const centerX = pos.x + 120 * c.scale;
  const centerY = pos.y + 120 * c.scale;
  return {
    x: centerX + a.offset.x,
    y: centerY + a.offset.y,
  };
}

/** 吸附半径（viewBox 像素） */
export const SNAP_RADIUS = 8;

/**
 * 找最近锚点（≤ SNAP_RADIUS 才返回）
 * @param pt 鼠标/候选坐标
 * @param positions 部件当前位置（用于组件锚点实时定位）
 */
export function findNearestComponentAnchor(
  pt: { x: number; y: number },
  positions: Record<string, { x: number; y: number }>
): ComponentAnchor | null {
  let best: ComponentAnchor | null = null;
  let bestDist = SNAP_RADIUS;
  for (const a of COMPONENT_ANCHORS) {
    const p = getAnchorPosition(a.id, positions);
    if (!p) continue;
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}