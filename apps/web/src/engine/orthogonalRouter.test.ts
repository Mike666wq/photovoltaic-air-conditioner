import { describe, expect, it } from 'vitest';
import { resolveCableRoutes, routeOrthogonal, simplifyOrthogonal } from './orthogonalRouter';

describe('orthogonal router', () => {
  it('生成仅含水平和垂直线段的路径', () => {
    const route = routeOrthogonal({ x: 0, y: 0 }, { x: 100, y: 80 }, 'right', 'left', []);
    for (let i = 1; i < route.length; i++) {
      expect(route[i].x === route[i - 1].x || route[i].y === route[i - 1].y).toBe(true);
    }
  });

  it('绕开中间障碍物', () => {
    const obstacle = { id: 'block', x: 40, y: -20, w: 30, h: 60 };
    const route = routeOrthogonal({ x: 0, y: 0 }, { x: 120, y: 0 }, 'right', 'left', [obstacle]);
    expect(route.some((point) => Math.abs(point.y) >= 40)).toBe(true);
  });

  it('删除重复和共线点', () => {
    expect(simplifyOrthogonal([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }])).toEqual([
      { x: 0, y: 0 }, { x: 20, y: 0 },
    ]);
  });

  it('多段逻辑线缆逐段解析，不折叠成首尾总线', () => {
    const anchors: Record<string, { x: number; y: number }> = {
      'a.right': { x: 10, y: 20 },
      'meter.left': { x: 50, y: 20 },
      'meter.right': { x: 70, y: 20 },
      'b.left': { x: 120, y: 20 },
    };
    const routes = resolveCableRoutes({
      id: 'multi', kind: 'power', animationEnabled: true, direction: 'forward',
      segments: [
        { fromAnchorId: 'a.right', toAnchorId: 'meter.left' },
        { fromAnchorId: 'meter.right', toAnchorId: 'b.left' },
      ],
    }, (id) => anchors[id] ?? null, []);
    expect(routes).toHaveLength(2);
    expect(routes[0].points[routes[0].points.length - 1]).toEqual(anchors['meter.left']);
    expect(routes[1].points[0]).toEqual(anchors['meter.right']);
    expect(routes.flatMap((route) => route.points)).not.toContainEqual({ x: 60, y: 20 });
  });
});
