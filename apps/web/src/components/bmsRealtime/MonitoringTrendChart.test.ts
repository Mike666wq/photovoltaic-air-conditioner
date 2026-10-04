import { describe, expect, it } from 'vitest';
import { buildTrendSeries } from './MonitoringTrendChart';

const point = (time: number, value: number | null, session = 'session-a') => ({
  time: new Date(time).toISOString(), value, session,
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
});
