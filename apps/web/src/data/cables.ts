// 默认与用户拖出的逻辑线缆（每条 1+ 直线段 CableSegment，端点吸附到锚点）
// 重构后无折线点数组，只有直线段 + 锚点引用

export type CableKind = 'power' | 'refrigerant' | 'water';

/** 粒子流动方向：只接受用户明确指定的正向或反向。 */
export type CableDirection = 'forward' | 'reverse';
export type CableDirectionMode = CableDirection;
export type CableRoutingMode = 'straight' | 'orthogonal-auto' | 'orthogonal-manual';

/** 直线段（端点必须是锚点 id：组件锚点 "comp.side"） */
export interface CableSegment {
  fromAnchorId: string;
  toAnchorId: string;
}

/** 逻辑线缆（1+ 直线段，段间共享端点形成 polyline） */
export interface Cable {
  id: string;
  kind: CableKind;
  /** 单段 → 直连；多段 → 共享端点的折线 */
  segments: CableSegment[];
  /** from 端浮动坐标（fromAnchorId 为空时使用） */
  floatingFrom?: { x: number; y: number } | null;
  /** to 端浮动坐标（toAnchorId 为空时使用） */
  floatingTo?: { x: number; y: number } | null;
  /** M1.5 Round 9 新增：此线缆粒子动画开关 */
  animationEnabled: boolean;
  /** M1.5 Round 9 新增：粒子流动方向 */
  direction: CableDirection;
  /** 与 direction 同步保存；保留字段名是为了兼容 v1/v2 场景。 */
  directionMode?: CableDirectionMode;
  /** 缺失时按 orthogonal-auto 处理，兼容旧场景。 */
  routeMode?: CableRoutingMode;
  /** 仅人工正交模式持久化；自动路由点由画布几何实时派生。 */
  manualWaypoints?: Array<{ x: number; y: number }>;
}

// 2×7 部件坐标（components.ts）
// 行1 (y=200): PV(100) | CB(340) | Grid(580) | GS(820) | IV(1060) | Bat(1300) | Load(1540)
// 行2 (y=750): HP(100) | Tank(340) | Pump(580) | PCM(820) | AT(1060) | PM(1300) | TS(1540)

// 锚点绝对坐标（components scale 已代入）
//   pv.right       (316, 308)   combiner-box.left  (340, 266)   combiner-box.right (472, 266)
//   combiner-box.bottom (406, 332)  grid.left (580, 266)  grid.right (712, 266)
//   grid-switch.left (820, 266)  grid-switch.right (952, 266)  grid-switch.bottom (886, 332)
//   inverter.left (1060, 314)  inverter.right (1288, 314)  inverter.top (1174, 200)  inverter.bottom (1174, 428)
//   battery.left (1300, 284)  battery.right (1468, 284)  battery.top (1384, 200)  battery.bottom (1384, 368)
//   load.left (1540, 266)  load.right (1672, 266)  load.top (1606, 200)
//   heat-pump.top (214, 750)  heat-pump.right (328, 864)  heat-pump.left (100, 864)  heat-pump.bottom (214, 978)
//   tank.left (340, 864)  tank.right (568, 864)  tank.top (454, 750)  tank.bottom (454, 978)
//   pump.left (580, 822)  pump.right (724, 822)  pump.top (652, 750)  pump.bottom (652, 894)
//   pcm.left (820, 834)  pcm.right (988, 834)
//   air-terminal.left (1060, 816)

function standardCable(
  id: string,
  kind: CableKind,
  fromAnchorId: string,
  toAnchorId: string,
  direction: CableDirection = 'forward',
): Cable {
  return {
    id,
    kind,
    segments: [{ fromAnchorId, toAnchorId }],
    floatingFrom: null,
    floatingTo: null,
    animationEnabled: true,
    direction,
    directionMode: direction,
    routeMode: 'orthogonal-auto',
  };
}

/**
 * 官方基准拓扑。
 *
 * 新建页面和“恢复标准拓扑”都从这里深克隆，空白设计图由 store 的独立 action 创建。
 * 每条逻辑线缆只描述真实设备端点；横平竖直与避障交给 orthogonalRouter，避免同时维护坐标副本。
 */
export const CABLES: Cable[] = [
  standardCable('standard-power-pv-combiner', 'power', 'pv-array.right', 'combiner-box.left'),
  standardCable('standard-power-combiner-inverter', 'power', 'combiner-box.right', 'inverter.left'),
  standardCable('standard-power-grid-switch', 'power', 'grid.right', 'grid-switch.left'),
  standardCable('standard-power-switch-inverter', 'power', 'grid-switch.right', 'inverter.top'),
  standardCable('standard-power-inverter-battery', 'power', 'inverter.right', 'battery.left'),
  standardCable('standard-power-battery-load', 'power', 'battery.right', 'load.left'),
  standardCable('standard-power-inverter-heat-pump', 'power', 'inverter.bottom', 'heat-pump.top'),
  standardCable('standard-refrigerant-heat-pump-tank', 'refrigerant', 'heat-pump.right', 'tank.left'),
  standardCable('standard-water-tank-pump', 'water', 'tank.right', 'pump.left'),
  standardCable('standard-water-pump-pcm', 'water', 'pump.right', 'pcm.left'),
  standardCable('standard-water-pcm-terminal', 'water', 'pcm.right', 'air-terminal.left'),
];

// 线缆颜色（视觉规范）
export const LINE_COLORS: Record<CableKind, string> = {
  power: '#E63946',
  refrigerant: '#2A9D8F',
  water: '#1D6996',
};
