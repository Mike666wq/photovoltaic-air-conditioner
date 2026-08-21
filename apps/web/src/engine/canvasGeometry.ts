import type { MeterInstance } from '../data/meters';
import type { Point, WorldRect } from './alignment';

export const COMPONENT_WORLD_SIZE = Object.freeze({ w: 180, h: 210 });
export const METER_WORLD_SIZE = Object.freeze({ w: 110, h: 130 });

export type CardPortSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * 卡片端口的唯一几何定义。后续如 SVG 增加 data-port，只需在这里替换归一化坐标，
 * 路由、吸附和动画无需再改。
 */
export const CARD_PORTS: Record<CardPortSide, Readonly<Point>> = Object.freeze({
  top: Object.freeze({ x: 0.5, y: 0 }),
  bottom: Object.freeze({ x: 0.5, y: 1 }),
  left: Object.freeze({ x: 0, y: 0.5 }),
  right: Object.freeze({ x: 1, y: 0.5 }),
});

export function cardWorldSize(id: string, meters: MeterInstance[]): { w: number; h: number } {
  return meters.some((meter) => meter.id === id) ? METER_WORLD_SIZE : COMPONENT_WORLD_SIZE;
}

export function cardWorldRect(
  id: string,
  position: Point,
  meters: MeterInstance[],
): WorldRect {
  return { id, ...position, ...cardWorldSize(id, meters) };
}

export function portPoint(rect: Pick<WorldRect, 'x' | 'y' | 'w' | 'h'>, side: CardPortSide): Point {
  const port = CARD_PORTS[side];
  return { x: rect.x + rect.w * port.x, y: rect.y + rect.h * port.y };
}

export interface CanvasInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 浮层面板不占 CSS grid 列，因此 fit/zoom 必须显式扣除其遮挡区域。 */
export function canvasInsets(options: {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  fullscreen: boolean;
}): CanvasInsets {
  if (options.fullscreen) return { left: 24, right: 24, top: 24, bottom: 24 };
  return {
    left: options.leftPanelOpen ? 184 : 64,
    right: options.rightPanelOpen ? 344 : 64,
    top: 24,
    bottom: 58,
  };
}

export function boundsOfRectsAndPoints(rects: WorldRect[], points: Point[], padding = 40) {
  if (!rects.length && !points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  for (const rect of rects) {
    xs.push(rect.x, rect.x + rect.w);
    ys.push(rect.y, rect.y + rect.h);
  }
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
  };
}
