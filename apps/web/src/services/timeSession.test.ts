import { describe, expect, it } from 'vitest';
import { prepareDataSource, type PreparedDataSource } from './dataSourcePipeline';
import { buildThermalMasterFrames, getSessionRanges } from './timeSession';

function makeSource(
  id: 'thermal' | 'bms',
  times: string[],
  overrides: Array<Record<string, string>> = [],
): PreparedDataSource {
  const isThermal = id === 'thermal';
  const headers = isThermal ? ['采样时刻', 'T0.PV', 'T4.PV', 'D1.PV'] : ['时间', '电压(V)', '电流(A)', 'SOC(%)'];
  const rows = times.map((time, index) => isThermal ? {
    '采样时刻': time, 'T0.PV': '20', 'T4.PV': '24', 'D1.PV': '220', ...(overrides[index] ?? {}),
  } : {
    时间: time, '电压(V)': '52', '电流(A)': '-2', 'SOC(%)': '30', ...(overrides[index] ?? {}),
  });
  return prepareDataSource({ id, filename: `${id}.xlsx`, format: 'xlsx', headers, rows });
}

describe('双源统一时间会话', () => {
  it('分别计算并集和交集时间范围', () => {
    const thermal = makeSource('thermal', ['2026/07/17 00:00:00', '2026/07/17 18:28:00']);
    const bms = makeSource('bms', ['2026/07/17 08:11:19', '2026/07/17 18:10:46']);
    const ranges = getSessionRanges([thermal, bms]);
    expect(ranges.union).toEqual({ start: thermal.timeStats.start, end: thermal.timeStats.end });
    expect(ranges.intersection).toEqual({ start: bms.timeStats.start, end: bms.timeStats.end });
  });

  it('以热工时间为主，默认容差两秒并接受正负一秒的最近 BMS 点', () => {
    const thermal = makeSource('thermal', [
      '2026/07/17 08:12:00', '2026/07/17 08:14:00', '2026/07/17 08:16:00',
    ]);
    const bms = makeSource('bms', [
      '2026/07/17 08:11:59', '2026/07/17 08:12:01',
      '2026/07/17 08:13:59', '2026/07/17 08:14:01',
      '2026/07/17 08:15:59', '2026/07/17 08:16:01',
    ]);
    const frames = buildThermalMasterFrames(thermal, bms);
    expect(frames.map((frame) => frame.bmsDistanceMs)).toEqual([1_000, 1_000, 1_000]);
    expect(frames.every((frame) => frame.bms != null)).toBe(true);
  });

  it('交集外和超出容差时明确返回缺失，不做前向填充', () => {
    const thermal = makeSource('thermal', [
      '2026/07/17 08:00:00', '2026/07/17 08:12:00', '2026/07/17 08:14:00', '2026/07/17 18:20:00',
    ]);
    const bms = makeSource('bms', ['2026/07/17 08:11:19', '2026/07/17 08:12:05', '2026/07/17 18:10:46']);
    const frames = buildThermalMasterFrames(thermal, bms);
    expect(frames.map((frame) => frame.bms)).toEqual([null, null, null, null]);
    expect(frames.map((frame) => frame.inIntersection)).toEqual([false, true, true, false]);
  });

  it('默认从主时间轴隔离热工异常行', () => {
    const thermal = makeSource('thermal', [
      '2026/07/17 08:12:00', '2026/07/17 08:14:00',
    ], [{ 'T4.PV': '220.4' }, {}]);
    const bms = makeSource('bms', ['2026/07/17 08:11:59', '2026/07/17 08:14:01']);
    const frames = buildThermalMasterFrames(thermal, bms);
    expect(frames).toHaveLength(1);
    expect(frames[0].thermal.raw['采样时刻']).toBe('2026/07/17 08:14:00');
  });
});

