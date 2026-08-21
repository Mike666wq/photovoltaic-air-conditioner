import { describe, expect, it } from 'vitest';
import { alignRects, autoAlignRects, computeObjectSnap, distributeRects, tidyRects } from './alignment';

describe('alignment engine', () => {
  it('按其它卡片中心吸附，并返回参考线', () => {
    const result = computeObjectSnap(
      { x: 96, y: 205 }, { w: 100, h: 80 },
      [{ id: 'a', x: 100, y: 100, w: 100, h: 80 }],
      { zoom: 1, gridSize: 20, snapToGrid: true, smartGuides: true },
    );
    expect(result.position).toEqual({ x: 100, y: 200 });
    expect(result.guides).toHaveLength(2);
  });

  it('缩小时仍按屏幕阈值吸附', () => {
    const result = computeObjectSnap(
      { x: 112, y: 0 }, { w: 50, h: 50 },
      [{ id: 'a', x: 100, y: 100, w: 50, h: 50 }],
      { zoom: 0.5, thresholdPx: 7, gridSize: 20, snapToGrid: false, smartGuides: true },
    );
    expect(result.position.x).toBe(100);
  });

  it('支持批量对齐、分布和整理', () => {
    const rects = [
      { id: 'a', x: 10, y: 20, w: 20, h: 20 },
      { id: 'b', x: 80, y: 50, w: 20, h: 20 },
      { id: 'c', x: 170, y: 80, w: 20, h: 20 },
    ];
    expect(alignRects(rects, 'top').b.y).toBe(20);
    expect(distributeRects(rects, 'x').b.x).toBe(90);
    expect(Object.keys(tidyRects(rects))).toHaveLength(3);
  });

  it('一键对齐只处理拓扑约束，不拉动无关对象', () => {
    const result = autoAlignRects([
      { id: 'a', x: 13, y: 17, w: 100, h: 80 },
      { id: 'b', x: 151, y: 22, w: 100, h: 80 },
      { id: 'c', x: 16, y: 210, w: 100, h: 80 },
    ], 20, [
      { axis: 'y', ids: ['a', 'b'] },
      { axis: 'x', ids: ['a', 'c'] },
    ]);
    expect(result.a.y).toBe(result.b.y);
    expect(result.a.x).toBe(result.c.x);
    expect(result.b.x).toBeGreaterThan(result.a.x);
  });

  it('将同一支路压紧成统一通道间距', () => {
    const result = autoAlignRects([
      { id: 'a', x: 0, y: 0, w: 100, h: 80 },
      { id: 'b', x: 300, y: 5, w: 100, h: 80 },
      { id: 'c', x: 800, y: -4, w: 100, h: 80 },
      { id: 'free', x: 1013, y: 333, w: 100, h: 80 },
    ], 20, [
      { axis: 'y', ids: ['a', 'b'] },
      { axis: 'y', ids: ['b', 'c'] },
    ]);
    expect(result.a.y).toBe(result.b.y);
    expect(result.b.y).toBe(result.c.y);
    expect(result.b.x - result.a.x).toBe(result.c.x - result.b.x);
    expect(result.free).toEqual({ x: 1013, y: 333 });
  });

  it('只移动允许消除重叠的未接线对象', () => {
    const result = autoAlignRects([
      { id: 'wired', x: 100, y: 100, w: 180, h: 200 },
      { id: 'free', x: 120, y: 100, w: 180, h: 200 },
    ], 20, [], { overlapMovableIds: new Set(['free']) });
    expect(result.wired).toEqual({ x: 100, y: 100 });
    expect(result.free).not.toEqual({ x: 120, y: 100 });
    const separated = result.free.x >= 300 || result.free.x + 200 <= 100
      || result.free.y >= 320 || result.free.y + 220 <= 100;
    expect(separated).toBe(true);
  });
});
