export interface Point {
  x: number;
  y: number;
}

export interface WorldRect extends Point {
  id: string;
  w: number;
  h: number;
}

export interface AlignmentGuide {
  axis: 'x' | 'y';
  value: number;
  from: number;
  to: number;
  kind: 'edge' | 'center' | 'grid' | 'spacing';
}

export interface SnapOptions {
  zoom: number;
  thresholdPx?: number;
  gridSize: number;
  snapToGrid: boolean;
  smartGuides: boolean;
  disabled?: boolean;
}

export interface SnapResult {
  position: Point;
  guides: AlignmentGuide[];
  snappedX: boolean;
  snappedY: boolean;
}

type Feature = { value: number; kind: 'edge' | 'center' };

function xFeatures(rect: Pick<WorldRect, 'x' | 'w'>): Feature[] {
  return [
    { value: rect.x, kind: 'edge' },
    { value: rect.x + rect.w / 2, kind: 'center' },
    { value: rect.x + rect.w, kind: 'edge' },
  ];
}

function yFeatures(rect: Pick<WorldRect, 'y' | 'h'>): Feature[] {
  return [
    { value: rect.y, kind: 'edge' },
    { value: rect.y + rect.h / 2, kind: 'center' },
    { value: rect.y + rect.h, kind: 'edge' },
  ];
}

/**
 * 计算拖动卡片的智能吸附结果。阈值以屏幕像素定义，再按 zoom 换算为世界坐标，
 * 从而保证不同缩放级别下手感一致。
 */
export function computeObjectSnap(
  rawPosition: Point,
  size: { w: number; h: number },
  others: WorldRect[],
  options: SnapOptions,
): SnapResult {
  if (options.disabled) {
    return { position: rawPosition, guides: [], snappedX: false, snappedY: false };
  }

  const threshold = (options.thresholdPx ?? 7) / Math.max(0.05, options.zoom);
  const dragged: WorldRect = { id: '__drag__', ...rawPosition, ...size };
  let bestX: { delta: number; score: number; guide: AlignmentGuide } | null = null;
  let bestY: { delta: number; score: number; guide: AlignmentGuide } | null = null;

  if (options.smartGuides) {
    for (const other of others) {
      for (const own of xFeatures(dragged)) {
        for (const target of xFeatures(other)) {
          const delta = target.value - own.value;
          const distance = Math.abs(delta);
          if (distance > threshold) continue;
          const centerPriority = own.kind === 'center' && target.kind === 'center' ? -0.25 : 0;
          const score = distance + centerPriority;
          if (!bestX || score < bestX.score) {
            bestX = {
              delta,
              score,
              guide: {
                axis: 'x', value: target.value,
                from: Math.min(dragged.y, other.y) - 12,
                to: Math.max(dragged.y + dragged.h, other.y + other.h) + 12,
                kind: target.kind,
              },
            };
          }
        }
      }

      for (const own of yFeatures(dragged)) {
        for (const target of yFeatures(other)) {
          const delta = target.value - own.value;
          const distance = Math.abs(delta);
          if (distance > threshold) continue;
          const centerPriority = own.kind === 'center' && target.kind === 'center' ? -0.25 : 0;
          const score = distance + centerPriority;
          if (!bestY || score < bestY.score) {
            bestY = {
              delta,
              score,
              guide: {
                axis: 'y', value: target.value,
                from: Math.min(dragged.x, other.x) - 12,
                to: Math.max(dragged.x + dragged.w, other.x + other.w) + 12,
                kind: target.kind,
              },
            };
          }
        }
      }
    }

    // 位于两张卡片之间时，吸附到等间距位置。判断基于边界而非中心，兼容不同尺寸。
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const a = others[i];
        const b = others[j];
        const left = a.x <= b.x ? a : b;
        const right = left === a ? b : a;
        const freeX = right.x - (left.x + left.w) - size.w;
        if (freeX >= 0) {
          const desiredX = left.x + left.w + freeX / 2;
          const distance = Math.abs(desiredX - rawPosition.x);
          if (distance <= threshold && (!bestX || distance < bestX.score)) {
            bestX = {
              delta: desiredX - rawPosition.x,
              score: distance,
              guide: { axis: 'x', value: desiredX, from: Math.min(left.y, right.y, rawPosition.y), to: Math.max(left.y + left.h, right.y + right.h, rawPosition.y + size.h), kind: 'spacing' },
            };
          }
        }
        const top = a.y <= b.y ? a : b;
        const bottom = top === a ? b : a;
        const freeY = bottom.y - (top.y + top.h) - size.h;
        if (freeY >= 0) {
          const desiredY = top.y + top.h + freeY / 2;
          const distance = Math.abs(desiredY - rawPosition.y);
          if (distance <= threshold && (!bestY || distance < bestY.score)) {
            bestY = {
              delta: desiredY - rawPosition.y,
              score: distance,
              guide: { axis: 'y', value: desiredY, from: Math.min(top.x, bottom.x, rawPosition.x), to: Math.max(top.x + top.w, bottom.x + bottom.w, rawPosition.x + size.w), kind: 'spacing' },
            };
          }
        }
      }
    }
  }

  let x = rawPosition.x;
  let y = rawPosition.y;
  const guides: AlignmentGuide[] = [];

  if (bestX) {
    x += bestX.delta;
    guides.push(bestX.guide);
  } else if (options.snapToGrid && options.gridSize > 0) {
    const gx = Math.round(x / options.gridSize) * options.gridSize;
    if (Math.abs(gx - x) <= threshold) {
      x = gx;
      guides.push({ axis: 'x', value: gx, from: y - 10, to: y + size.h + 10, kind: 'grid' });
    }
  }

  if (bestY) {
    y += bestY.delta;
    guides.push(bestY.guide);
  } else if (options.snapToGrid && options.gridSize > 0) {
    const gy = Math.round(y / options.gridSize) * options.gridSize;
    if (Math.abs(gy - y) <= threshold) {
      y = gy;
      guides.push({ axis: 'y', value: gy, from: x - 10, to: x + size.w + 10, kind: 'grid' });
    }
  }

  return { position: { x, y }, guides, snappedX: !!bestX, snappedY: !!bestY };
}

export type AlignCommand = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export interface AlignmentConstraint {
  axis: 'x' | 'y';
  ids: string[];
}

export interface AutoAlignOptions {
  /** 仅这些完全未接线的对象允许为了消除重叠而移动。 */
  overlapMovableIds?: ReadonlySet<string>;
  overlapGap?: number;
}

export function alignRects(rects: WorldRect[], command: AlignCommand): Record<string, Point> {
  if (rects.length < 2) return {};
  const minX = Math.min(...rects.map((r) => r.x));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return Object.fromEntries(rects.map((r) => {
    let x = r.x;
    let y = r.y;
    if (command === 'left') x = minX;
    if (command === 'hcenter') x = cx - r.w / 2;
    if (command === 'right') x = maxX - r.w;
    if (command === 'top') y = minY;
    if (command === 'vcenter') y = cy - r.h / 2;
    if (command === 'bottom') y = maxY - r.h;
    return [r.id, { x, y }];
  }));
}

export function distributeRects(rects: WorldRect[], axis: 'x' | 'y'): Record<string, Point> {
  if (rects.length < 3) return {};
  const sorted = [...rects].sort((a, b) => axis === 'x' ? a.x - b.x : a.y - b.y);
  const totalSize = sorted.reduce((sum, r) => sum + (axis === 'x' ? r.w : r.h), 0);
  const start = axis === 'x' ? sorted[0].x : sorted[0].y;
  const end = axis === 'x'
    ? sorted[sorted.length - 1].x + sorted[sorted.length - 1].w
    : sorted[sorted.length - 1].y + sorted[sorted.length - 1].h;
  const gap = (end - start - totalSize) / (sorted.length - 1);
  let cursor = start;
  const result: Record<string, Point> = {};
  for (const rect of sorted) {
    result[rect.id] = axis === 'x' ? { x: cursor, y: rect.y } : { x: rect.x, y: cursor };
    cursor += (axis === 'x' ? rect.w : rect.h) + gap;
  }
  return result;
}

/** 按当前视觉行聚类，保持行内顺序并统一间距。 */
export function tidyRects(rects: WorldRect[], gapX = 40, gapY = 56): Record<string, Point> {
  if (rects.length < 2) return {};
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const avgHeight = sorted.reduce((sum, r) => sum + r.h, 0) / sorted.length;
  const rows: WorldRect[][] = [];
  for (const rect of sorted) {
    const row = rows.find((items) => Math.abs(items.reduce((sum, r) => sum + r.y, 0) / items.length - rect.y) <= avgHeight * 0.55);
    if (row) row.push(rect); else rows.push([rect]);
  }
  rows.forEach((row) => row.sort((a, b) => a.x - b.x));
  const originX = Math.min(...rects.map((r) => r.x));
  let y = Math.min(...rects.map((r) => r.y));
  const result: Record<string, Point> = {};
  for (const row of rows) {
    let x = originX;
    const rowHeight = Math.max(...row.map((r) => r.h));
    for (const rect of row) {
      result[rect.id] = { x, y: y + (rowHeight - rect.h) / 2 };
      x += rect.w + gapX;
    }
    y += rowHeight + gapY;
  }
  return result;
}

/**
 * 拓扑感知的一键对齐：
 * - 横向直连器件共用中心线，纵向直连器件共用中心列；
 * - 三个及以上的同一支路只在原有首尾范围内做等间距分布；
 * - 无拓扑关系的对象保持原位，避免一次操作重排整张原理图。
 */
export function autoAlignRects(
  rects: WorldRect[],
  gridSize = 20,
  constraints: AlignmentConstraint[] = [],
  options: AutoAlignOptions = {},
): Record<string, Point> {
  if (rects.length === 0) return {};
  const result = Object.fromEntries(rects.map((rect) => [rect.id, {
    x: rect.x,
    y: rect.y,
  }]));

  const rectById = new Map(rects.map((rect) => [rect.id, rect]));
  const buildGroups = (axis: 'x' | 'y') => {
    const parent = new Map(rects.map((rect) => [rect.id, rect.id]));
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (a: string, b: string) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    };
    for (const constraint of constraints.filter((item) => item.axis === axis)) {
      const ids = constraint.ids.filter((id) => rectById.has(id));
      for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    }
    const groups = new Map<string, WorldRect[]>();
    for (const rect of rects) {
      const root = find(rect.id);
      groups.set(root, [...(groups.get(root) ?? []), rect]);
    }
    return { find, groups };
  };

  const xGroups = buildGroups('x');
  const yGroups = buildGroups('y');

  const layoutDimension = (
    dimension: 'x' | 'y',
    aligned: ReturnType<typeof buildGroups>,
    relationAxis: 'x' | 'y',
  ): Map<string, number> => {
    const currentCenter = new Map<string, number>();
    const halfSize = new Map<string, number>();
    for (const [root, items] of aligned.groups) {
      const centers = items.map((rect) => dimension === 'x'
        ? rect.x + rect.w / 2
        : rect.y + rect.h / 2).sort((a, b) => a - b);
      const median = centers[Math.floor(centers.length / 2)];
      // 只有真正需要共线的组才吸附中心通道；单独对象不做任何位移。
      currentCenter.set(root, items.length > 1 && gridSize > 0
        ? Math.round(median / gridSize) * gridSize
        : median);
      halfSize.set(root, Math.max(...items.map((rect) => (dimension === 'x' ? rect.w : rect.h) / 2)));
    }

    const adjacency = new Map<string, Set<string>>([...aligned.groups.keys()].map((root) => [root, new Set()]));
    for (const constraint of constraints.filter((item) => item.axis === relationAxis)) {
      const roots = [...new Set(constraint.ids.filter((id) => rectById.has(id)).map((id) => aligned.find(id)))];
      for (let i = 1; i < roots.length; i++) {
        adjacency.get(roots[0])?.add(roots[i]);
        adjacency.get(roots[i])?.add(roots[0]);
      }
    }

    const distributed = new Map(currentCenter);
    const visited = new Set<string>();
    for (const root of aligned.groups.keys()) {
      if (visited.has(root)) continue;
      const component: string[] = [];
      const stack = [root];
      visited.add(root);
      while (stack.length) {
        const current = stack.pop()!;
        component.push(current);
        for (const next of adjacency.get(current) ?? []) {
          if (!visited.has(next)) { visited.add(next); stack.push(next); }
        }
      }
      // 两个对象不存在“等分间距”的问题，保留原有远近；三项起才分布。
      if (component.length < 3) continue;
      component.sort((a, b) => (currentCenter.get(a) ?? 0) - (currentCenter.get(b) ?? 0));
      const first = currentCenter.get(component[0]) ?? 0;
      const last = currentCenter.get(component[component.length - 1]) ?? 0;
      const occupied = component.reduce((sum, item) => sum + (halfSize.get(item) ?? 0) * 2, 0);
      const availableGap = (last - first
        - (halfSize.get(component[0]) ?? 0)
        - (halfSize.get(component[component.length - 1]) ?? 0)
        - (occupied - (halfSize.get(component[0]) ?? 0) * 2 - (halfSize.get(component[component.length - 1]) ?? 0) * 2))
        / (component.length - 1);
      if (availableGap < 0) continue;
      const assigned: number[] = [first];
      for (let i = 1; i < component.length; i++) {
        assigned[i] = assigned[i - 1]
          + (halfSize.get(component[i - 1]) ?? 0)
          + availableGap
          + (halfSize.get(component[i]) ?? 0);
      }
      component.forEach((item, index) => distributed.set(item, assigned[index]));
    }
    return distributed;
  };

  // 水平连接关系决定列分布；垂直连接关系决定行分布。
  const xCenters = layoutDimension('x', xGroups, 'y');
  const yCenters = layoutDimension('y', yGroups, 'x');

  for (const rect of rects) {
    const xCenter = xCenters.get(xGroups.find(rect.id));
    const yCenter = yCenters.get(yGroups.find(rect.id));
    if (xCenter != null) result[rect.id].x = xCenter - rect.w / 2;
    if (yCenter != null) result[rect.id].y = yCenter - rect.h / 2;
  }

  const movable = options.overlapMovableIds;
  if (movable?.size) {
    const gap = options.overlapGap ?? Math.max(12, gridSize);
    const step = Math.max(5, gridSize);
    const collides = (candidate: WorldRect) => rects.some((other) => {
      if (other.id === candidate.id) return false;
      const otherPos = result[other.id];
      return candidate.x < otherPos.x + other.w + gap
        && candidate.x + candidate.w + gap > otherPos.x
        && candidate.y < otherPos.y + other.h + gap
        && candidate.y + candidate.h + gap > otherPos.y;
    });
    for (const rect of rects.filter((item) => movable.has(item.id))) {
      const current = { ...rect, ...result[rect.id] };
      if (!collides(current)) continue;
      const origin = { x: Math.round(rect.x / step) * step, y: Math.round(rect.y / step) * step };
      let placed: Point | null = null;
      for (let radius = 1; radius <= 30 && !placed; radius++) {
        const offsets: Point[] = [
          { x: 0, y: radius }, { x: radius, y: 0 },
          { x: -radius, y: 0 }, { x: 0, y: -radius },
        ];
        for (let cross = 1; cross < radius; cross++) {
          offsets.push(
            { x: cross, y: radius }, { x: -cross, y: radius },
            { x: radius, y: cross }, { x: radius, y: -cross },
            { x: -radius, y: cross }, { x: -radius, y: -cross },
            { x: cross, y: -radius }, { x: -cross, y: -radius },
          );
        }
        for (const offset of offsets) {
          const candidate = { ...rect, x: origin.x + offset.x * step, y: origin.y + offset.y * step };
          if (!collides(candidate)) { placed = { x: candidate.x, y: candidate.y }; break; }
        }
      }
      if (placed) result[rect.id] = placed;
    }
  }

  return result;
}
