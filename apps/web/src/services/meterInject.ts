// M2-β：仪表实例按数据源绑定（bind）从采集数据集当前行取真实值注入
// 无数据集 / 未匹配列时 → 回退到默认值（滑块 / 固定常量）

import type { SimulationState } from '../store/simulation';
import type { MeterInstance } from '../data/meters';
import { TEMP_BIND_PDF_COLUMN } from '../data/meters';
import {
  METER_BIND_COLUMNS,
  PCM_COLUMNS,
} from './pdfFieldMap';
import { CHART_FIELDS, normalizeChartHeader } from '../data/chartFields';
import {
  findNearestPlaybackRow,
  getUsableTimedRows,
  type TimedPreparedRow,
} from './playbackSession';
import type { InjectionDataset } from '../store/simulation';

const BMS_TOLERANCE_MS = 2_000;

const timedRowCache = new WeakMap<InjectionDataset['prepared'], TimedPreparedRow[]>();

function nearestRow(
  source: InjectionDataset,
  cursorMs: number,
): Record<string, string> | null {
  let rows = timedRowCache.get(source.prepared);
  if (!rows) {
    rows = getUsableTimedRows(source.prepared);
    timedRowCache.set(source.prepared, rows);
  }
  return findNearestPlaybackRow(rows, cursorMs, BMS_TOLERANCE_MS)?.raw ?? null;
}

/** 当前统一时间游标下所有有效源行；不做跨边界前向填充。 */
export function getCurrentRows(state: SimulationState): Array<Record<string, string>> {
  if (state.playbackSnapshot) {
    return state.playbackSnapshot.sourceIds.flatMap((sourceId) => {
      const source = state.injectionSources.find((candidate) => candidate.sourceId === sourceId);
      const rowIndex = state.playbackSnapshot?.sourceRowIndices[sourceId];
      const row = rowIndex == null ? null : source?.prepared.processedRows[rowIndex]?.raw;
      return row ? [row] : [];
    });
  }
  const master = getCurrentRow(state);
  if (!master) return [];
  const result = [master];
  if (state.timelineMode !== 'combined' || state.timelineCursorMs == null) return result;
  const activeIds = new Set(state.activePlaybackSourceIds);
  for (const source of state.injectionSources) {
    if (activeIds.size && !activeIds.has(source.sourceId)) continue;
    if (source.sourceId === state.injectionDataset?.sourceId || source.role !== 'battery-bms' || !source.timeColumn) continue;
    const row = nearestRow(source, state.timelineCursorMs);
    if (row) result.push(row);
  }
  return result;
}

/** 当前回放行（无数据集 / index 越界 → null） */
export function getCurrentRow(state: SimulationState): Record<string, string> | null {
  const ds = state.injectionDataset;
  if (!ds || ds.rows.length === 0) return null;
  if (state.playbackSnapshot) {
    const rowIndex = state.playbackSnapshot.sourceRowIndices[ds.sourceId];
    return rowIndex == null ? null : ds.prepared.processedRows[rowIndex]?.raw ?? null;
  }
  if (state.timelineIndex < 0) return null;
  const row = ds.rows[Math.min(state.timelineIndex, ds.rows.length - 1)];
  return row ?? null;
}

/** 某 PDF 列在当前行的值（无数据 → null） */
export function readCell(state: SimulationState, pdfHeader: string): number | null {
  for (const row of getCurrentRows(state)) {
    const v = row[pdfHeader] ?? row[pdfHeader.replace('.', '_')];
    if (v == null || String(v).trim() === '') continue;
    const n = parseFloat(String(v));
    if (!isNaN(n)) return n;
  }
  const normalized = normalizeChartHeader(pdfHeader);
  const canonical = CHART_FIELDS.find((field) =>
    field.aliases.some((alias) => normalizeChartHeader(alias) === normalized),
  );
  if (canonical && state.playbackSnapshot?.availability[canonical.key]) {
    const value = state.playbackSnapshot.values[canonical.key];
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** 从候选列中取第一个非空数值（支持 PDF 列名 + XLSX 中文列名） */
export function readCellCandidates(
  state: SimulationState,
  candidates: string[],
): number | null {
  for (const c of candidates) {
    const v = readCell(state, c);
    if (v != null) return v;
  }
  return null;
}

/** 环境温度检测器的候选列：PDF T3.PV + XLSX 环境温度 */
export const ENV_TEMP_COLUMNS = ['T3.PV', 'T3_PV', '环境温度'];

/** 温度归一化 0..1（10~100℃ 映射，供 ts_anim_temp 水银柱） */
export function normTemp(t: number): number {
  return Math.max(0, Math.min(1, (t - 10) / 90));
}

/** 温度文本（无数据 → '—'） */
function fmtTemp(v: number | null): string {
  return v == null ? '—' : v.toFixed(1);
}

export interface MeterInjectData {
  fields: Record<string, string>;
  animations: Record<string, number | string>;
}

/** 温度类绑定（TS）：标签 + 值 + 水银柱 */
function buildTempInject(
  state: SimulationState,
  meter: MeterInstance,
): MeterInjectData {
  const bind = meter.bind;
  const isTempBind =
    bind === 'env-temp' || bind === 'supply-temp' || bind === 'return-temp' || bind === 'outlet-temp';
  // env-temp 支持 PDF T3.PV + XLSX 环境温度两路候选列；其余走绑定 PDF 列
  const live = bind === 'env-temp'
    ? readCellCandidates(state, ENV_TEMP_COLUMNS)
    : (isTempBind ? readCell(state, TEMP_BIND_PDF_COLUMN[bind]) : null);
  // 仅静态仿真模式允许回退；采集会话中缺失必须显示“不可用”，不能沿用旧值。
  let fallback: number;
  switch (bind) {
    case 'env-temp': fallback = state.at_temp; break;
    case 'supply-temp': fallback = state.tank_temp; break;
    case 'return-temp': fallback = state.tank_temp; break;
    case 'outlet-temp': fallback = state.at_temp; break;
    default: fallback = state.tank_temp;
  }
  const hasDataSession = state.controlMode === 'replay' && state.playbackSnapshot != null;
  const t = live ?? (hasDataSession ? null : fallback);
  const label = bind === 'env-temp' ? '环境温度'
    : bind === 'supply-temp' ? '送水温度'
    : bind === 'return-temp' ? '回水温度'
    : bind === 'outlet-temp' ? '出风温度' : '温度';

  return {
    fields: {
      ts_value: fmtTemp(t),
      ts_label: label,
      ts_unit: '℃',
      ts_trend: live == null ? '' : (live >= fallback ? '↑' : '↓'),
      ts_id: bind ?? 'TS',
    },
    animations: {
      ts_anim_temp: t == null ? 0 : normTemp(t),
    },
  };
}

/** 功率类绑定（PM）：三圆盘 V/A/kW + 总功率因数。D6/DU6 不是累计电能。 */
function buildMeterInject(
  state: SimulationState,
  meter: MeterInstance,
): MeterInjectData {
  const bind = meter.bind === 'meter-du' ? 'meter-du' : 'meter-d';
  const cols = METER_BIND_COLUMNS[bind];
  const v = readCell(state, cols.voltage);
  const a = readCell(state, cols.current);
  const p = readCell(state, cols.power);
  const pf = readCell(state, cols.powerFactor);

  // 只有完全未导入数据时才使用仿真值；已导入但当前时刻无值必须显示“—”。
  const fallbackV = 220;
  const fallbackA = state.pv_power / 0.38 / 3;
  const fallbackP = state.load_power_kw;
  const fallbackPf = 1;

  const hasDataSession = state.controlMode === 'replay' && state.playbackSnapshot != null;
  const fmt = (n: number | null, fallback: number, digits = 1): string =>
    n != null ? n.toFixed(digits) : (hasDataSession ? '—' : fallback.toFixed(digits));

  return {
    fields: {
      pm_id: bind === 'meter-du' ? '市电 DU' : '电表 D',
      pm_l1_value: fmt(v, fallbackV, 1),   // 行 1：电压 V
      pm_l2_value: fmt(a, fallbackA, 1),   // 行 2：电流 A
      pm_l3_value: fmt(p, fallbackP, 2),   // 行 3：功率 kW
      pm_total: fmt(pf, fallbackPf, 2),    // 总功率因数 PF
    },
    animations: {
      // 红色脉冲 LED 按功率比例闪烁
      pm_pulse_speed: p ?? (hasDataSession ? 0 : fallbackP),
    },
  };
}

/** PCM 双相变材料：按 state.pcm_temp_select 取 T0/T1 温度 */
export function buildPcmInjectData(state: SimulationState) {
  const sel = state.pcm_temp_select;
  const pdfCol = sel === 'T1' ? PCM_COLUMNS['pcm-t1'] : PCM_COLUMNS['pcm-t0'];
  const live = readCell(state, pdfCol);
  return {
    liveTemp: live,
    selectLabel: sel,  // 'T0' | 'T1'
  };
}

/** 仪表实例注入（MeterSlot 使用） */
export function buildMeterInjectData(
  state: SimulationState,
  meter: MeterInstance,
): MeterInjectData {
  if (meter.type === 'temp-sensor') {
    return buildTempInject(state, meter);
  }
  return buildMeterInject(state, meter);
}
