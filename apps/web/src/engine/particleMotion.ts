import type { Point } from './alignment';

export function polylineLength(points: Point[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

/** 屏幕速度转换成世界距离；结果始终落在当前路径长度内。 */
export function advanceParticleDistance(
  distance: number,
  pixelsPerSecond: number,
  deltaMilliseconds: number,
  zoom: number,
  pathLength: number,
): number {
  if (pathLength <= 0 || pixelsPerSecond <= 0 || deltaMilliseconds <= 0) return Math.max(0, distance);
  const worldDelta = pixelsPerSecond * (deltaMilliseconds / 1000) / Math.max(0.2, zoom);
  return ((distance + worldDelta) % pathLength + pathLength) % pathLength;
}
