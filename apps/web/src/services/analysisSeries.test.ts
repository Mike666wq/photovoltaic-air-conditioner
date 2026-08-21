import { describe, expect, it } from 'vitest';
import { findChartField, readChartNumber } from '../data/chartFields';
import {
  aggregateCumulativeEnergy,
  aggregatePowerEnergy,
  aggregateSignedPowerEnergy,
  buildSynchronizedAnalysisPoints,
  downsampleSeriesForChart,
  findNearestAnalysisPoint,
  getDerivedSeries,
  indexAnalysisPointsBySource,
  type AnalysisPoint,
} from './analysisSeries';
import { parseDatasetTime } from './dataset';

describe('M3 图表字段与能量统计', () => {
  it('将 D6/DU6 识别为功率因数，将 D8/DU8 识别为累计电能', () => {
    expect(findChartField('system_power_factor')?.semantic).toBe('instant');
    expect(findChartField('system_energy')?.semantic).toBe('cumulative');
    expect(readChartNumber({ 'D8.PV': '12.5' }, 'system_energy')).toBe(12.5);
    expect(readChartNumber({ DU6_PV: '0.98' }, 'grid_power_factor')).toBe(0.98);
  });

  it('对瞬时功率按真实时间积分', () => {
    const start = new Date('2026-07-14T10:00:00+08:00').getTime();
    const buckets = aggregatePowerEnergy([
      { timestamp: start, value: 2 },
      { timestamp: start + 60 * 60 * 1000, value: 2 },
    ], 'hour');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].value).toBeCloseTo(2, 8);
  });

  it('对累计电能做差分而不做求和', () => {
    const start = new Date('2026-07-14T10:00:00+08:00').getTime();
    const buckets = aggregateCumulativeEnergy([
      { timestamp: start, value: 100 },
      { timestamp: start + 20 * 60 * 1000, value: 100.4 },
      { timestamp: start + 40 * 60 * 1000, value: 101.1 },
    ], 'hour');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].value).toBeCloseTo(1.1, 8);
  });

  it('将累计电能跨整点的差分按北京时间自然小时拆分，并拒绝跨来源差分', () => {
    const start = new Date('2026-07-14T23:40:00+08:00').getTime();
    const buckets = aggregateCumulativeEnergy([
      { timestamp: start, value: 100, sourceId: 'a' },
      { timestamp: start + 40 * 60 * 1000, value: 102, sourceId: 'a' },
      { timestamp: start + 60 * 60 * 1000, value: 104, sourceId: 'b' },
    ], 'hour');
    expect(buckets.map((bucket) => bucket.key)).toEqual(['07-14 23:00', '07-15 00:00']);
    expect(buckets.map((bucket) => bucket.value)).toEqual([1, 1]);
  });

  it('将无时区采样时间按北京时间分桶，不受浏览器本地时区影响', () => {
    const start = parseDatasetTime('2026-07-14 23:40:00');
    const end = parseDatasetTime('2026-07-15 00:20:00');
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    const buckets = aggregatePowerEnergy([
      { timestamp: start!, value: 3 },
      { timestamp: end!, value: 3 },
    ], 'hour');
    expect(buckets.map((bucket) => bucket.key)).toEqual(['07-14 23:00', '07-15 00:00']);
    expect(buckets.map((bucket) => bucket.value)).toEqual([1, 1]);
  });

  it('在功率穿越零点时精确拆分充电和放电能量', () => {
    const start = new Date('2026-07-14T10:00:00+08:00').getTime();
    const series = [{ timestamp: start, value: -1, sourceId: 'bms' }, { timestamp: start + 3_600_000, value: 1, sourceId: 'bms' }];
    expect(aggregateSignedPowerEnergy(series, 'negative', 'hour')[0].value).toBeCloseTo(0.25, 8);
    expect(aggregateSignedPowerEnergy(series, 'positive', 'hour')[0].value).toBeCloseTo(0.25, 8);
  });

  it('在非对称零交叉时仍按原始线性功率精确积分', () => {
    const start = new Date('2026-07-14T10:00:00+08:00').getTime();
    const series = [{ timestamp: start, value: -2, sourceId: 'bms' }, { timestamp: start + 3_600_000, value: 1, sourceId: 'bms' }];
    expect(aggregateSignedPowerEnergy(series, 'negative', 'hour')[0].value).toBeCloseTo(2 / 3, 8);
    expect(aggregateSignedPowerEnergy(series, 'positive', 'hour')[0].value).toBeCloseTo(1 / 6, 8);
  });

  it('BMS 剩余能量优先使用剩余 Ah 与包电压，而非固定 10 kWh', () => {
    const derived = getDerivedSeries([{
      timestamp: new Date('2026-07-15T10:16:20+08:00').getTime(), sourceId: 'bms',
      values: { battery_voltage: 52.37, battery_remaining_ah: 22.48, battery_soc: 22 },
    }], 'battery_remaining_energy');
    expect(derived[0].value).toBeCloseTo(1.177, 3);
  });

  it('交集同步通过来源时间索引二分匹配最近点', () => {
    const points: AnalysisPoint[] = [
      { timestamp: 1_000, sourceId: 'thermal', values: { outlet_temp: 25 } },
      { timestamp: 1_001, sourceId: 'bms', values: { battery_soc: 60 } },
      { timestamp: 3_000, sourceId: 'bms', values: { battery_soc: 59 } },
    ];
    const index = indexAnalysisPointsBySource(points);
    expect(findNearestAnalysisPoint(index.get('bms') ?? [], 1_000, 2)?.timestamp).toBe(1_001);
    expect(findNearestAnalysisPoint(index.get('bms') ?? [], 2_000, 100)).toBeNull();
  });

  it('同步交集只保留容差内匹配点，并包含主轴边界外 1 秒的 BMS 点', () => {
    const points: AnalysisPoint[] = [
      { timestamp: 1_000, sourceId: 'thermal', values: { outlet_temp: 25 } },
      { timestamp: 3_000, sourceId: 'thermal', values: { outlet_temp: 26 } },
      { timestamp: 1_001, sourceId: 'bms', values: { battery_soc: 60 } },
      { timestamp: 2_000, sourceId: 'bms', values: { battery_soc: 59.5 } },
      { timestamp: 3_001, sourceId: 'bms', values: { battery_soc: 59 } },
    ];
    const synchronized = buildSynchronizedAnalysisPoints(
      indexAnalysisPointsBySource(points),
      ['thermal', 'bms'],
      'thermal',
      2,
    );
    expect(synchronized.anchors.map((point) => point.timestamp)).toEqual([1_000, 3_000]);
    expect(synchronized.points.map((point) => point.timestamp)).toEqual([1_000, 1_001, 3_000, 3_001]);
    expect(synchronized.points.some((point) => point.timestamp === 2_000)).toBe(false);
  });

  it('曲线抽稀限制显示点数并保留首末点与尖峰', () => {
    const series = Array.from({ length: 10_000 }, (_, index) => ({
      timestamp: index,
      value: index === 5_432 ? 999 : Math.sin(index / 100),
      sourceId: 'bms',
    }));
    const sampled = downsampleSeriesForChart(series, 800);
    expect(sampled.length).toBeLessThanOrEqual(800);
    expect(sampled[0]).toEqual(series[0]);
    expect(sampled[sampled.length - 1]).toEqual(series[series.length - 1]);
    expect(sampled.some((point) => point.timestamp === 5_432 && point.value === 999)).toBe(true);
  });
});
