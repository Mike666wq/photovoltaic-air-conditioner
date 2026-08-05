// 13 固定部件坐标 + 元数据
// 2×7 布局（1800×1100），仪表 (PM/TS) 由调色板拖出生成，不在固定布局内
// 行1 (y=200): PV | CB | Grid | GS | IV | Bat | Load
// 行2 (y=750): HP | Tank | Pump | PCM | AT | Solar Air Cooler

export interface ComponentDef {
  id: string;
  name: string;
  type: '电源' | '配电' | '外部电源' | '电力电子' | '储能' | '负载' | '冷热源' | '蓄能' | '输送' | '末端' | '仪表';
  x: number;
  y: number;
  scale: number;
  spec: string;
  rating: string;
}

// 列坐标（7 等距）
const COL_X = [100, 340, 580, 820, 1060, 1300, 1540] as const;
const ROW1_Y = 200;
const ROW2_Y = 750;

export const COMPONENTS: ComponentDef[] = [
  // === 行1: 电源/储能/负载 ===
  { id: 'pv-array',     name: '光伏阵列',     type: '电源',       x: COL_X[0], y: ROW1_Y, scale: 0.9,  spec: '5 kWp',    rating: 'DC 5kWp · 6 块板' },
  { id: 'combiner-box', name: '汇流箱',       type: '配电',       x: COL_X[1], y: ROW1_Y, scale: 0.55, spec: '1000V/32A', rating: 'DC 1000V · 32A' },
  { id: 'grid',         name: '电网',         type: '外部电源',   x: COL_X[2], y: ROW1_Y, scale: 0.55, spec: '380V/220V', rating: 'AC 380V/220V · 50Hz' },
  { id: 'grid-switch',  name: '并网开关',     type: '配电',       x: COL_X[3], y: ROW1_Y, scale: 0.55, spec: '100A',     rating: '额定电流 100A' },
  { id: 'inverter',     name: '双向逆变器',   type: '电力电子',   x: COL_X[4], y: ROW1_Y, scale: 0.95, spec: '10 kW',    rating: 'DC ⇄ AC · 10 kW' },
  { id: 'battery',      name: '蓄电池',       type: '储能',       x: COL_X[5], y: ROW1_Y, scale: 0.7,  spec: '10 kWh',   rating: 'LiFePO4 · 10 kWh' },
  { id: 'load',         name: '室内用电',     type: '负载',       x: COL_X[6], y: ROW1_Y, scale: 0.55, spec: '0.62 kW',  rating: '实时负载 · 客厅' },

  // === 行2: 冷热源/蓄能/输送/末端 ===
  { id: 'heat-pump',    name: '热泵机组',     type: '冷热源',     x: COL_X[0], y: ROW2_Y, scale: 0.95, spec: '8 kW',     rating: 'COP 3.8 · 制冷/制热' },
  { id: 'tank',         name: '水箱',         type: '蓄能',       x: COL_X[1], y: ROW2_Y, scale: 0.95, spec: '300L',     rating: '300L + 盘管' },
  { id: 'pump',         name: '循环水泵',     type: '输送',       x: COL_X[2], y: ROW2_Y, scale: 0.6,  spec: '0.75kW',   rating: 'H=3m · 流量可调' },
  { id: 'pcm',          name: '相变材料',     type: '蓄能',       x: COL_X[3], y: ROW2_Y, scale: 0.7,  spec: 'PCM 50kg', rating: '融化/凝固 0~50℃' },
  { id: 'air-terminal', name: '末端风盘',     type: '末端',       x: COL_X[4], y: ROW2_Y, scale: 0.55, spec: '3 台',     rating: '送风温度可调' },
  { id: 'solar-air-cooler', name: '太阳能水冷风扇', type: '末端',   x: COL_X[5], y: ROW2_Y, scale: 0.75, spec: '12/24V DC', rating: '内置水箱 · 水泵 · 风机' },
];

// SVG 路径映射
export const SVG_FILES: Record<string, string> = {
  'pv-array': 'pv-array.svg',
  'combiner-box': 'combiner-box.svg',
  'grid': 'grid.svg',
  'grid-switch': 'grid-switch.svg',
  'inverter': 'inverter.svg',
  'battery': 'battery.svg',
  'load': 'load.svg',
  'heat-pump': 'heat-pump.svg',
  'tank': 'tank.svg',
  'pump': 'pump.svg',
  'pcm': 'pcm.svg',
  'air-terminal': 'air-terminal.svg',
  'solar-air-cooler': 'solar-air-cooler.svg',
  'power-meter': 'power-meter.svg',
  'temp-sensor': 'temp-sensor.svg',
};

// 画布尺寸常量（M1 重构后画布改用 HTML 卡片网格，viewBox 不再使用，保留供兼容）
export const VIEW_W = 1800;
export const VIEW_H = 1100;
