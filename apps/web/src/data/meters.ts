// 仪表实例（被拖到画布后产生的对象）

import type { MeterType } from './palettes';

export type MeterMount = 'free' | 'component' | 'cable';

/**
 * 仪表数据源绑定：决定该实例显示哪个采集字段
 * - PM 类：绑定电表（D 系列）或市电（DU 系列），圆盘显示 电压/电流/有功功率，底栏显示功率因数
 * - TS 类：绑定一个温度采集点
 */
export type MeterBind =
  | 'meter-d'        // 电表（DS666H）：D1 电压 / D2 电流 / D3 有功功率 / D6 功率因数
  | 'meter-du'       // 市电表（DDSU66）：DU1 电压 / DU2 电流 / DU3 有功功率 / DU6 功率因数
  | 'env-temp'       // 环境温度 T3
  | 'supply-temp'    // 送水温度 T4
  | 'return-temp'    // 回水温度 T5
  | 'outlet-temp';   // 出风温度 T2

export interface MeterInstance {
  id: string;
  type: MeterType;
  /** 数据源绑定：决定该实例显示哪个采集字段（未绑定 = 显示默认值） */
  bind?: MeterBind;
  /** 挂载方式 */
  mount: MeterMount;
  /** mount='cable' 时必填 */
  cableId?: string;
  /** 0..1 沿线缆位置 */
  offsetOnCable?: number;
  /** mount='component' 时必填（吸附到部件或仪表卡片 4 边锚点） */
  anchorId?: string;
  /** 自由 / 当前位置（绝对画布像素坐标） */
  position: { x: number; y: number };
  /** 预置仪表：viewBox 逻辑坐标（渲染时按 canvas 缩放）；用户手动拖动后清除 */
  presetVb?: { x: number; y: number };
}

/** 预置仪表清单（画布行 3，y≈980）：2 功率检测器 + 4 温度检测器 */
export const PRESET_METERS: MeterInstance[] = [
  { id: 'pm-meter-d',   type: 'power-meter', bind: 'meter-d',   mount: 'free', position: { x: 0, y: 0 }, presetVb: { x: 820, y: 980 } },
  { id: 'pm-meter-du',  type: 'power-meter', bind: 'meter-du',  mount: 'free', position: { x: 0, y: 0 }, presetVb: { x: 1300, y: 980 } },
  { id: 'ts-env',       type: 'temp-sensor', bind: 'env-temp',    mount: 'free', position: { x: 0, y: 0 }, presetVb: { x: 100, y: 980 } },
  { id: 'ts-supply',    type: 'temp-sensor', bind: 'supply-temp', mount: 'free', position: { x: 0, y: 0 }, presetVb: { x: 340, y: 980 } },
  { id: 'ts-return',    type: 'temp-sensor', bind: 'return-temp', mount: 'free', position: { x: 0, y: 0 }, presetVb: { x: 580, y: 980 } },
  { id: 'ts-outlet',    type: 'temp-sensor', bind: 'outlet-temp', mount: 'free', position: { x: 0, y: 0 }, presetVb: { x: 1540, y: 980 } },
];

/** 仪表绑定 → 中文标签（卡片标题 + 内部显示） */
export const METER_BIND_LABELS: Record<MeterBind, string> = {
  'meter-d':      '电表 D',
  'meter-du':     '市电 DU',
  'env-temp':     '环境温度',
  'supply-temp':  '送水温度',
  'return-temp':  '回水温度',
  'outlet-temp':  '出风温度',
};

/** PDF 列载体去向标签（含 PCM 双温度，供 ImportDataDialog 展示列去向） */
export const PDF_BIND_LABELS: Record<MeterBind | 'pcm-t0' | 'pcm-t1', string> = {
  'meter-d':      'PM 电表 D',
  'meter-du':     'PM 市电 DU',
  'env-temp':     'TS 环境温度',
  'supply-temp':  'TS 送水温度',
  'return-temp':  'TS 回水温度',
  'outlet-temp':  'TS 出风温度',
  'pcm-t0':       'PCM (T0)',
  'pcm-t1':       'PCM (T1)',
};

/** 仪表绑定 → 温度对应 PDF 列名（T3/T4/T5/T2） */
export const TEMP_BIND_PDF_COLUMN: Record<Exclude<MeterBind, 'meter-d' | 'meter-du'>, string> = {
  'env-temp':     'T3.PV',
  'supply-temp':  'T4.PV',
  'return-temp':  'T5.PV',
  'outlet-temp':  'T2.PV',
};
