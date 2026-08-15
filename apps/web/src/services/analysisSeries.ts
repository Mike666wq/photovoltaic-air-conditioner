import { CHART_FIELDS, findChartField, readChartNumber } from '../data/chartFields';
import { parseDatasetTime } from './dataset';
import type { AnalysisSource, EnergyGranularity } from '../store/analysis';

export interface AnalysisPoint {
  timestamp: number;
  sourceId: string;
  values: Record<string, number>;
}

export interface SeriesPoint {
  timestamp: number;
  value: number;
  sourceId?: string;
}

export interface EnergyBucket {
  key: string;
  start: number;
  value: number;
}

const MAX_GAP_MS = 5 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function buildAnalysisPoints(sources: AnalysisSource[]): AnalysisPoint[] {
  const points: AnalysisPoint[] = [];
  for (const source of sources) {
    if (!source.timeColumn) continue;
    for (const row of source.rows) {
      const timestamp = parseDatasetTime(row[source.timeColumn]);
      if (timestamp == null) continue;
      const values: Record<string, number> = {};
      for (const field of CHART_FIELDS) {
        const value = readChartNumber(row, field.key);
        if (value != null) values[field.key] = value;
      }
      if (Object.keys(values).length > 0) points.push({ timestamp, sourceId: source.id, values });
    }
  }
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

export function filterPoints(points: AnalysisPoint[], range: [number, number] | null): AnalysisPoint[] {
  if (!range) return points;
  return points.filter((point) => point.timestamp >= range[0] && point.timestamp <= range[1]);
}

export function buildSeries(points: AnalysisPoint[], fieldKey: string): SeriesPoint[] {
  return points.flatMap((point) => {
    const value = point.values[fieldKey];
    return Number.isFinite(value) ? [{ timestamp: point.timestamp, value, sourceId: point.sourceId }] : [];
  });
}

export function getCurrentValue(points: AnalysisPoint[], fieldKey: string): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const value = points[i].values[fieldKey];
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function getDerivedSeries(points: AnalysisPoint[], fieldKey: 'battery_power' | 'battery_remaining_energy' | 'cooling_power'): SeriesPoint[] {
  return points.flatMap((point) => {
    if (fieldKey === 'battery_power') {
      const voltage = point.values.battery_voltage;
      const current = point.values.battery_current;
      return Number.isFinite(voltage) && Number.isFinite(current)
        ? [{ timestamp: point.timestamp, value: voltage * current / 1000, sourceId: point.sourceId }]
        : [];
    }
    if (fieldKey === 'battery_remaining_energy') {
      const voltage = point.values.battery_voltage;
      const remainingAh = point.values.battery_remaining_ah;
      const fullAh = point.values.battery_full_capacity_ah;
      const soc = point.values.battery_soc;
      // BMS 优先给出 Ah 与包电压；缺少剩余 Ah 时再用 SOC × 满充容量估算。
      const capacityAh = Number.isFinite(remainingAh)
        ? remainingAh
        : Number.isFinite(fullAh) && Number.isFinite(soc) ? fullAh * soc / 100 : null;
      return Number.isFinite(voltage) && capacityAh != null && Number.isFinite(capacityAh)
        ? [{ timestamp: point.timestamp, value: voltage * capacityAh / 1000, sourceId: point.sourceId }]
        : [];
    }
    const flow = point.values.water_flow;
    const supply = point.values.supply_water_temp;
    const returnTemp = point.values.return_water_temp;
    return Number.isFinite(flow) && Number.isFinite(supply) && Number.isFinite(returnTemp)
      ? [{ timestamp: point.timestamp, value: 1.163 * flow * Math.abs(returnTemp - supply), sourceId: point.sourceId }]
      : [];
  });
}

function startOfBucket(timestamp: number, granularity: EnergyGranularity): number {
  const local = new Date(timestamp + SHANGHAI_OFFSET_MS);
  if (granularity === 'hour') {
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours()) - SHANGHAI_OFFSET_MS;
  }
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - SHANGHAI_OFFSET_MS;
}

function nextBucket(start: number, granularity: EnergyGranularity): number {
  const local = new Date(start + SHANGHAI_OFFSET_MS);
  if (granularity === 'hour') {
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours() + 1) - SHANGHAI_OFFSET_MS;
  }
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - SHANGHAI_OFFSET_MS;
}

function formatBucket(start: number, granularity: EnergyGranularity): string {
  const local = new Date(start + SHANGHAI_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return granularity === 'hour' ? `${m}-${d} ${String(local.getUTCHours()).padStart(2, '0')}:00` : `${y}-${m}-${d}`;
}

function medianInterval(series: SeriesPoint[]): number {
  const intervals = series.slice(1).map((point, index) => point.timestamp - series[index].timestamp).filter((value) => value > 0);
  if (!intervals.length) return MAX_GAP_MS;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
}

function getBucket(buckets: Map<number, number>, start: number): void {
  if (!buckets.has(start)) buckets.set(start, 0);
}

/** 对瞬时功率（kW）按真实时间戳进行梯形积分，并精确拆分至逐时/逐日桶。 */
export function aggregatePowerEnergy(series: SeriesPoint[], granularity: EnergyGranularity): EnergyBucket[] {
  const buckets = new Map<number, number>();
  const gapLimit = Math.max(MAX_GAP_MS, medianInterval(series) * 3);
  for (let index = 1; index < series.length; index++) {
    const previous = series[index - 1];
    const current = series[index];
    const duration = current.timestamp - previous.timestamp;
    if (duration <= 0 || duration > gapLimit || previous.sourceId !== current.sourceId) continue;
    let cursor = previous.timestamp;
    while (cursor < current.timestamp) {
      const bucketStart = startOfBucket(cursor, granularity);
      const boundary = Math.min(nextBucket(bucketStart, granularity), current.timestamp);
      const ratioStart = (cursor - previous.timestamp) / duration;
      const ratioEnd = (boundary - previous.timestamp) / duration;
      const powerStart = previous.value + (current.value - previous.value) * ratioStart;
      const powerEnd = previous.value + (current.value - previous.value) * ratioEnd;
      const energy = ((powerStart + powerEnd) / 2) * (boundary - cursor) / 3_600_000;
      getBucket(buckets, bucketStart);
      buckets.set(bucketStart, (buckets.get(bucketStart) ?? 0) + Math.max(0, energy));
      cursor = boundary;
    }
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([start, value]) => ({ key: formatBucket(start, granularity), start, value }));
}

/**
 * 精确积分带方向的功率。相邻采样点异号时先插入线性零交叉点，
 * 再对正部（放电）或负部绝对值（充电）积分，避免梯形法跨零高估三角形面积。
 */
export function aggregateSignedPowerEnergy(
  series: SeriesPoint[],
  direction: 'positive' | 'negative',
  granularity: EnergyGranularity,
): EnergyBucket[] {
  const split: SeriesPoint[] = [];
  for (let index = 0; index < series.length; index++) {
    const current = series[index];
    if (index > 0) {
      const previous = series[index - 1];
      const duration = current.timestamp - previous.timestamp;
      if (duration > 0 && previous.sourceId === current.sourceId && previous.value * current.value < 0) {
        const zeroAt = previous.timestamp + duration * Math.abs(previous.value) / (Math.abs(previous.value) + Math.abs(current.value));
        split.push({ timestamp: zeroAt, value: 0, sourceId: current.sourceId });
      }
    }
    split.push(current);
  }
  return aggregatePowerEnergy(split.map((point) => ({
    ...point,
    value: direction === 'positive' ? Math.max(point.value, 0) : Math.max(-point.value, 0),
  })), granularity);
}

/**
 * 对累计电能表（kWh）做正向差分；按相邻读数间的线性变化拆分到自然时段。
 * 遇到不同来源、长断档或表计回绕/清零时不跨越计量，避免把缺失期能耗误归入后一桶。
 */
export function aggregateCumulativeEnergy(series: SeriesPoint[], granularity: EnergyGranularity): EnergyBucket[] {
  const buckets = new Map<number, number>();
  const gapLimit = Math.max(MAX_GAP_MS, medianInterval(series) * 3);
  for (let index = 1; index < series.length; index++) {
    const previous = series[index - 1];
    const current = series[index];
    const duration = current.timestamp - previous.timestamp;
    const delta = current.value - previous.value;
    if (duration <= 0 || duration > gapLimit || previous.sourceId !== current.sourceId || delta < 0 || !Number.isFinite(delta)) continue;
    let cursor = previous.timestamp;
    while (cursor < current.timestamp) {
      const bucketStart = startOfBucket(cursor, granularity);
      const boundary = Math.min(nextBucket(bucketStart, granularity), current.timestamp);
      const share = delta * (boundary - cursor) / duration;
      getBucket(buckets, bucketStart);
      buckets.set(bucketStart, (buckets.get(bucketStart) ?? 0) + share);
      cursor = boundary;
    }
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([start, value]) => ({ key: formatBucket(start, granularity), start, value }));
}

export function aggregateEnergy(
  points: AnalysisPoint[],
  cumulativeField: string,
  powerField: string,
  granularity: EnergyGranularity,
): EnergyBucket[] {
  const cumulative = buildSeries(points, cumulativeField);
  const cumulativeBuckets = cumulative.length >= 2 ? aggregateCumulativeEnergy(cumulative, granularity) : [];
  // 累计列存在但没有形成有效相邻读数（跨来源、断档或回绕）时，安全回退至瞬时有功功率积分。
  return cumulativeBuckets.length > 0 ? cumulativeBuckets : aggregatePowerEnergy(buildSeries(points, powerField), granularity);
}

export function aggregateLastValue(points: AnalysisPoint[], fieldKey: string, granularity: EnergyGranularity): EnergyBucket[] {
  return aggregateLastSeriesValue(buildSeries(points, fieldKey), granularity);
}

/** 对任意时点量（SOC、BMS 剩余能量等）取每个自然桶的末值，不参与求和。 */
export function aggregateLastSeriesValue(series: SeriesPoint[], granularity: EnergyGranularity): EnergyBucket[] {
  const buckets = new Map<number, number>();
  for (const point of series) {
    const value = point.value;
    if (!Number.isFinite(value)) continue;
    buckets.set(startOfBucket(point.timestamp, granularity), value);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([start, value]) => ({ key: formatBucket(start, granularity), start, value }));
}

export function sumBuckets(buckets: EnergyBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.value, 0);
}

export function calculateDataCompleteness(points: AnalysisPoint[], fieldKeys: string[]): number {
  if (!points.length || !fieldKeys.length) return 0;
  const expected = points.length * fieldKeys.length;
  const actual = points.reduce((count, point) => count + fieldKeys.filter((key) => Number.isFinite(point.values[key])).length, 0);
  return actual / expected;
}

export function fieldLabel(key: string): string {
  return findChartField(key)?.label ?? key;
}
