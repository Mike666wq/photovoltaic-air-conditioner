import { describe, expect, it } from 'vitest';
import { buildTrendSeries } from './MonitoringTrendChart';

const point = (time: number, value: number | null, session = 'session-a') => ({
  time: new Date(time).toISOString(), value, session,
});
const bmsPoint = (time: number, value: number | null, periodSeconds?: number, session = 'session-a') => ({
  ...point(time, value, session), periodSeconds,
});

describe('buildTrendSeries', () => {
  it('keeps source null observations as line breaks without inventing a value', () => {
    const built = buildTrendSeries([{ id: 't1', name: '温度', unit: '℃', points: [
      point(1_000, 20), point(2_000, null), point(3_000, 22),
    ] }]);

    expect(built[0].data).toEqual([[1_000, 20], [2_000, null], [3_000, 22]]);
  });

  it('inserts a visual null at a session boundary even when timestamps are close', () => {
    const built = buildTrendSeries([{ id: 't1', name: '温度', unit: '℃', points: [
      point(1_000, 20, 'old-session'), point(2_000, 21, 'new-session'),
    ] }]);

    expect(built[0].data).toEqual([[1_000, 20], [2_000, null], [2_000, 21]]);
  });

  it('inserts a visual null when the observation gap exceeds gapMs', () => {
    const built = buildTrendSeries([{ id: 't1', name: '温度', unit: '℃', points: [
      point(1_000, 20), point(32_001, 21),
    ] }], 30_000);

    expect(built[0].data).toEqual([[1_000, 20], [32_001, null], [32_001, 21]]);
  });

  it('preserves every actual point and sorts by observation time without downsampling', () => {
    const points = Array.from({ length: 2_501 }, (_, index) => point(10_000 + index, index));
    const shuffled = [points[2], points[0], ...points.slice(3), points[1]];
    const built = buildTrendSeries([{ id: 'dense', name: '温度', unit: '℃', points: shuffled }]);

    expect(built[0].data).toHaveLength(2_501);
    expect(built[0].data[0]).toEqual([10_000, 0]);
    expect(built[0].data[built[0].data.length - 1]).toEqual([12_500, 2_500]);
  });

  it('uses each declared BMS period for 300 second sampling and keeps dense samples connected', () => {
    const built = buildTrendSeries([{ id: 'bms', name: '总电压', unit: 'V', points: [
      bmsPoint(0, 53, 300), bmsPoint(300_000, 54, 300), bmsPoint(600_000, 55, 300),
    ] }]);
    expect(built[0].data).toEqual([[0, 53], [300_000, 54], [600_000, 55]]);
    expect(built[0].isolatedPointIndices).toEqual([]);
  });

  it('breaks gaps beyond 1.5 times the preceding valid declared period', () => {
    const built = buildTrendSeries([{ id: 'bms', name: '总电压', unit: 'V', points: [
      bmsPoint(0, 53, 300), bmsPoint(450_001, 54, 300),
    ] }]);
    expect(built[0].data).toEqual([[0, 53], [450_001, null], [450_001, 54]]);
  });

  it('shows every isolated point including zero and points after explicit nulls', () => {
    const built = buildTrendSeries([{ id: 'bms', name: '电流', unit: 'A', points: [
      bmsPoint(0, 0, 300), bmsPoint(300_000, null, 300), bmsPoint(600_000, 2, 300),
      bmsPoint(900_000, null, 300), bmsPoint(1_200_000, -1, 300),
    ] }]);
    expect(built[0].data).toEqual([[0, 0], [300_000, null], [600_000, 2], [900_000, null], [1_200_000, -1]]);
    expect(built[0].isolatedPointIndices).toEqual([0, 2, 4]);
  });

  it('uses the previous period across a period change, then applies the new period', () => {
    const built = buildTrendSeries([{ id: 'bms', name: 'SOC', unit: '%', points: [
      bmsPoint(0, 10, 300), bmsPoint(300_000, 11, 10), bmsPoint(320_000, 12, 10),
    ] }]);
    expect(built[0].data).toEqual([[0, 10], [300_000, 11], [320_000, 12]]);
  });

  it('uses a fast previous period before a slow period change, then uses the slow period', () => {
    const built = buildTrendSeries([{ id: 'bms', name: 'SOC', unit: '%', points: [
      bmsPoint(0, 10, 10), bmsPoint(31_000, 11, 300), bmsPoint(331_000, 12, 300),
    ] }]);
    expect(built[0].data).toEqual([[0, 10], [31_000, null], [31_000, 11], [331_000, 12]]);
  });

  it('falls back to 30 seconds for absent or invalid periods and retains session breaks', () => {
    const built = buildTrendSeries([{ id: 'bms', name: 'SOC', unit: '%', points: [
      bmsPoint(0, 10, 0), bmsPoint(30_001, 11, Number.NaN),
      bmsPoint(60_000, 12, undefined, 'session-b'),
    ] }]);
    expect(built[0].data).toEqual([[0, 10], [30_001, null], [30_001, 11], [60_000, null], [60_000, 12]]);
    expect(built[0].isolatedPointIndices).toEqual([0, 2, 4]);
  });
});
