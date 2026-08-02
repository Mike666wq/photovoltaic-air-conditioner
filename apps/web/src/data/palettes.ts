// 调色板：3 种线缆（左侧 PalettePanel 用）
// 线缆区：可无限拖出色块（用 SVG 内 <line> 简短表示）

export type CableKind = 'power' | 'refrigerant' | 'water';

export const CABLE_PALETTE: { kind: CableKind; label: string; color: string }[] = [
  { kind: 'power',       label: '电力线',   color: '#E63946' },
  { kind: 'refrigerant', label: '制冷剂线', color: '#2A9D8F' },
  { kind: 'water',       label: '水线',     color: '#1D6996' },
];

// 仪表调色板（左侧 PalettePanel 用）
export type MeterType = 'power-meter' | 'temp-sensor';

export const METER_PALETTE: { type: MeterType; label: string; symbol: string; color: string }[] = [
  { type: 'power-meter', label: '功率检测器', symbol: 'A', color: '#EAB308' },
  { type: 'temp-sensor', label: '温度检测器', symbol: 'T', color: '#0EA5E9' },
];

export const METER_FILES: Record<MeterType, string> = {
  'power-meter': 'power-meter.svg',
  'temp-sensor': 'temp-sensor.svg',
};