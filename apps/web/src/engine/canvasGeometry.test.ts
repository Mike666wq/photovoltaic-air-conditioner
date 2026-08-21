import { describe, expect, it } from 'vitest';
import { boundsOfRectsAndPoints, canvasInsets, COMPONENT_WORLD_SIZE, portPoint } from './canvasGeometry';

describe('canvas geometry', () => {
  it('端口严格来自固定世界尺寸', () => {
    const rect = { x: 100, y: 200, ...COMPONENT_WORLD_SIZE };
    expect(portPoint(rect, 'left')).toEqual({ x: 100, y: 305 });
    expect(portPoint(rect, 'right')).toEqual({ x: 280, y: 305 });
    expect(portPoint(rect, 'top')).toEqual({ x: 190, y: 200 });
  });

  it('展开面板会缩小安全视口', () => {
    expect(canvasInsets({ leftPanelOpen: true, rightPanelOpen: true, fullscreen: false }))
      .toEqual({ left: 184, right: 344, top: 24, bottom: 58 });
  });

  it('内容边界包含卡片、折点和 padding', () => {
    expect(boundsOfRectsAndPoints(
      [{ id: 'a', x: 100, y: 100, w: 180, h: 210 }],
      [{ x: 400, y: 50 }],
      20,
    )).toEqual({ minX: 80, minY: 30, maxX: 420, maxY: 330 });
  });

});
