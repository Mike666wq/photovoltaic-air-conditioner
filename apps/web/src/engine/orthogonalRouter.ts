import type { Point, WorldRect } from './alignment';
import type { Cable, CableRoutingMode } from '../data/cables';

export type PortSide = 'top' | 'bottom' | 'left' | 'right' | null;

export interface ResolvedCablePath {
  segmentIndex: number;
  fromAnchorId: string;
  toAnchorId: string;
  points: Point[];
}

export interface ResolvedAnchorPort {
  ownerId: string;
  side: PortSide;
}

function sideOf(anchorId: string): PortSide {
  const match = anchorId.match(/\.(top|bottom|left|right)$/);
  return (match?.[1] as PortSide) ?? null;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

export function simplifyOrthogonal(points: Point[]): Point[] {
  const deduped = points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));
  const result: Point[] = [];
  for (const point of deduped) {
    const a = result[result.length - 2];
    const b = result[result.length - 1];
    if (a && b && ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

function stub(point: Point, side: PortSide, length: number): Point {
  if (side === 'left') return { x: point.x - length, y: point.y };
  if (side === 'right') return { x: point.x + length, y: point.y };
  if (side === 'top') return { x: point.x, y: point.y - length };
  if (side === 'bottom') return { x: point.x, y: point.y + length };
  return point;
}

function segmentHitsRect(a: Point, b: Point, rect: WorldRect): boolean {
  const eps = 0.01;
  if (Math.abs(a.x - b.x) < eps) {
    return a.x > rect.x + eps && a.x < rect.x + rect.w - eps
      && Math.max(a.y, b.y) > rect.y + eps && Math.min(a.y, b.y) < rect.y + rect.h - eps;
  }
  if (Math.abs(a.y - b.y) < eps) {
    return a.y > rect.y + eps && a.y < rect.y + rect.h - eps
      && Math.max(a.x, b.x) > rect.x + eps && Math.min(a.x, b.x) < rect.x + rect.w - eps;
  }
  return true;
}

function pathHitsObstacles(points: Point[], obstacles: WorldRect[]): boolean {
  for (let i = 1; i < points.length; i++) {
    if (obstacles.some((rect) => segmentHitsRect(points[i - 1], points[i], rect))) return true;
  }
  return false;
}

function pathScore(points: Point[], obstacles: WorldRect[]): number {
  if (pathHitsObstacles(points, obstacles)) return Number.POSITIVE_INFINITY;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  }
  return length + Math.max(0, points.length - 2) * 36;
}

function orthogonalJoin(a: Point, b: Point): Point[][] {
  if (a.x === b.x || a.y === b.y) return [[a, b]];
  return [
    [a, { x: b.x, y: a.y }, b],
    [a, { x: a.x, y: b.y }, b],
  ];
}

/**
 * 生成确定性的正交路径。先尝试直线/L/Z 型，再尝试沿所有障碍物外侧通道绕行。
 * 自动结果是派生数据，不写入存档；只有人工折点需要持久化。
 */
export function routeOrthogonal(
  from: Point,
  to: Point,
  fromSide: PortSide,
  toSide: PortSide,
  obstacles: WorldRect[],
  clearance = 22,
): Point[] {
  const start = stub(from, fromSide, clearance);
  const end = stub(to, toSide, clearance);
  const candidates: Point[][] = [];
  for (const middle of orthogonalJoin(start, end)) candidates.push([from, ...middle, to]);

  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  candidates.push([from, start, { x: midX, y: start.y }, { x: midX, y: end.y }, end, to]);
  candidates.push([from, start, { x: start.x, y: midY }, { x: end.x, y: midY }, end, to]);

  const xLanes = new Set<number>();
  const yLanes = new Set<number>();
  for (const rect of obstacles) {
    xLanes.add(rect.x - clearance);
    xLanes.add(rect.x + rect.w + clearance);
    yLanes.add(rect.y - clearance);
    yLanes.add(rect.y + rect.h + clearance);
  }
  for (const x of xLanes) {
    candidates.push([from, start, { x, y: start.y }, { x, y: end.y }, end, to]);
  }
  for (const y of yLanes) {
    candidates.push([from, start, { x: start.x, y }, { x: end.x, y }, end, to]);
  }

  if (obstacles.length) {
    const outerXs = [
      Math.min(...obstacles.map((rect) => rect.x)) - clearance,
      Math.max(...obstacles.map((rect) => rect.x + rect.w)) + clearance,
    ];
    const outerYs = [
      Math.min(...obstacles.map((rect) => rect.y)) - clearance,
      Math.max(...obstacles.map((rect) => rect.y + rect.h)) + clearance,
    ];
    for (const x of outerXs) for (const y of outerYs) {
      candidates.push([from, start, { x, y: start.y }, { x, y }, { x: end.x, y }, end, to]);
      candidates.push([from, start, { x: start.x, y }, { x, y }, { x, y: end.y }, end, to]);
    }
  }

  let best = simplifyOrthogonal(candidates[0]);
  let bestScore = pathScore(best, obstacles);
  for (const candidate of candidates.slice(1)) {
    const simplified = simplifyOrthogonal(candidate);
    const score = pathScore(simplified, obstacles);
    if (score < bestScore) {
      best = simplified;
      bestScore = score;
    }
  }
  // 宁可明确无路可走，也不能返回穿过设备的首个候选。
  return Number.isFinite(bestScore) ? best : [];
}

function routeThroughWaypoints(points: Point[]): Point[] {
  const result: Point[] = [];
  for (let i = 1; i < points.length; i++) {
    const variants = orthogonalJoin(points[i - 1], points[i]);
    const chosen = variants[0];
    if (result.length === 0) result.push(...chosen);
    else result.push(...chosen.slice(1));
  }
  return simplifyOrthogonal(result);
}

export function resolveCableRoute(
  cable: Cable,
  getAnchorPos: (anchorId: string) => Point | null,
  obstacles: WorldRect[],
): Point[] {
  const segments = cable.segments;
  if (segments.length === 0) return [];
  const fromAnchor = segments[0].fromAnchorId;
  const toAnchor = segments[segments.length - 1].toAnchorId;
  const from = (fromAnchor ? getAnchorPos(fromAnchor) : null) ?? cable.floatingFrom ?? null;
  const to = (toAnchor ? getAnchorPos(toAnchor) : null) ?? cable.floatingTo ?? null;
  if (!from && !to) return [];
  if (!from) return [to!];
  if (!to) return [from];

  const mode: CableRoutingMode = cable.routeMode ?? 'orthogonal-auto';
  if (mode === 'straight') return [from, to];
  if (mode === 'orthogonal-manual' && cable.manualWaypoints?.length) {
    return routeThroughWaypoints([from, ...cable.manualWaypoints, to]);
  }

  const sourceOwner = fromAnchor.replace(/\.(top|bottom|left|right)$/, '');
  const targetOwner = toAnchor.replace(/\.(top|bottom|left|right)$/, '');
  const relevantObstacles = obstacles.filter((rect) => rect.id !== sourceOwner && rect.id !== targetOwner);
  return routeOrthogonal(from, to, sideOf(fromAnchor), sideOf(toAnchor), relevantObstacles);
}

/**
 * 逐 CableSegment 解析路径。逻辑线缆的 segment 可能彼此不连续（例如通过仪表、
 * 设备或 cable: 接点组成支路），禁止把第一段起点与最后一段终点强行拼接。
 */
export function resolveCableRoutes(
  cable: Cable,
  getAnchorPos: (anchorId: string) => Point | null,
  obstacles: WorldRect[],
  getAnchorPort?: (anchorId: string) => ResolvedAnchorPort | null,
): ResolvedCablePath[] {
  return cable.segments.map((segment, segmentIndex) => {
    const from = (segment.fromAnchorId ? getAnchorPos(segment.fromAnchorId) : null)
      ?? (segmentIndex === 0 ? cable.floatingFrom ?? null : null);
    const to = (segment.toAnchorId ? getAnchorPos(segment.toAnchorId) : null)
      ?? (segmentIndex === cable.segments.length - 1 ? cable.floatingTo ?? null : null);
    if (!from && !to) return { segmentIndex, ...segment, points: [] };
    if (!from) return { segmentIndex, ...segment, points: [to!] };
    if (!to) return { segmentIndex, ...segment, points: [from] };

    const fromPort = getAnchorPort?.(segment.fromAnchorId) ?? {
      ownerId: segment.fromAnchorId.replace(/\.(top|bottom|left|right)$/, ''),
      side: sideOf(segment.fromAnchorId),
    };
    const toPort = getAnchorPort?.(segment.toAnchorId) ?? {
      ownerId: segment.toAnchorId.replace(/\.(top|bottom|left|right)$/, ''),
      side: sideOf(segment.toAnchorId),
    };
    const relevantObstacles = obstacles.filter((rect) =>
      rect.id !== fromPort?.ownerId && rect.id !== toPort?.ownerId,
    );
    const mode: CableRoutingMode = cable.routeMode ?? 'orthogonal-auto';
    let points: Point[];
    if (mode === 'straight') points = [from, to];
    else if (mode === 'orthogonal-manual' && cable.segments.length === 1 && cable.manualWaypoints?.length) {
      points = routeThroughWaypoints([from, ...cable.manualWaypoints, to]);
    } else {
      points = routeOrthogonal(from, to, fromPort?.side ?? null, toPort?.side ?? null, relevantObstacles);
    }
    return { segmentIndex, ...segment, points };
  });
}

export function pointsToSvg(points: Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}
