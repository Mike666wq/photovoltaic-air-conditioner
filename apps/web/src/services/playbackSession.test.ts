import { describe, expect, it } from 'vitest';
import { prepareDataSource, type PreparedDataSource } from './dataSourcePipeline';
import { parseDatasetTime } from './dataset';
import {
  buildPlaybackSession,
  findNearestPlaybackRow,
  getUsableTimedRows,
} from './playbackSession';

function source(
  id: string,
  headers: string[],
  rows: Array<Record<string, string>>,
): PreparedDataSource {
  return prepareDataSource({ id, filename: `${id}.xlsx`, format: 'xlsx', headers, rows });
}

describe('通用严格同步播放会话', () => {
  it('支持 N 源严格交集，并输出匹配距离、来源证据和规范字段', () => {
    const thermal = source('thermal', ['时间', 'T4.PV'], [
      { 时间: '2026-07-17 08:00:00', 'T4.PV': '24' },
      { 时间: '2026-07-17 08:02:00', 'T4.PV': '25' },
      { 时间: '2026-07-17 08:04:00', 'T4.PV': '26' },
    ]);
    const bms = source('bms', ['时间', 'SOC(%)'], [
      { 时间: '2026-07-17 07:59:59', 'SOC(%)': '61' },
      { 时间: '2026-07-17 08:00:01', 'SOC(%)': '60' },
      { 时间: '2026-07-17 08:02:01', 'SOC(%)': '59' },
    ]);
    const auxiliary = source('aux', ['时间', 'hp_power'], [
      { 时间: '2026-07-17 08:00:02', hp_power: '1.2' },
      { 时间: '2026-07-17 08:02:02', hp_power: '1.3' },
      { 时间: '2026-07-17 08:04:03', hp_power: '1.4' },
    ]);

    const session = buildPlaybackSession({
      sources: [bms, thermal, auxiliary],
      anchorSourceId: 'thermal',
      toleranceMs: 2_000,
    });

    expect(session.sourceIds).toEqual(['thermal', 'bms', 'aux']);
    expect(session.anchorCandidateCount).toBe(3);
    expect(session.rejectedAnchorCount).toBe(1);
    expect(session.frames).toHaveLength(2);
    expect(session.frames[0].samples.bms.raw['SOC(%)']).toBe('61');
    expect(session.frames[0].distancesMs).toEqual({ thermal: 0, bms: 1_000, aux: 2_000 });
    expect(session.frames[0].maxDistanceMs).toBe(2_000);
    expect(session.frames[0].values).toMatchObject({
      supply_water_temp: 24,
      battery_soc: 61,
      hp_power: 1.2,
    });
    expect(session.frames[0].provenance.battery_soc).toMatchObject({
      sourceId: 'bms',
      sourceFile: 'bms.xlsx',
      distanceMs: 1_000,
      sourceColumn: 'SOC(%)',
    });
    expect(session.range).toEqual({
      start: parseDatasetTime('2026-07-17 08:00:00'),
      end: parseDatasetTime('2026-07-17 08:02:00'),
    });
  });

  it('等距最近点固定选择较早采样，与大屏现行规则一致', () => {
    const bms = source('bms', ['时间', 'SOC(%)'], [
      { 时间: '2026-07-17 08:00:01', 'SOC(%)': '60' },
      { 时间: '2026-07-17 07:59:59', 'SOC(%)': '61' },
    ]);
    const rows = getUsableTimedRows(bms);
    const nearest = findNearestPlaybackRow(
      rows,
      parseDatasetTime('2026-07-17 08:00:00')!,
      2_000,
    );
    expect(nearest?.raw['SOC(%)']).toBe('61');
  });

  it('隔离质量无效行，并从最终交集帧而非原始 timeStats 计算范围', () => {
    const thermal = source('thermal', ['时间', 'T4.PV'], [
      { 时间: '2026-07-17 08:00:00', 'T4.PV': '220.4' },
      { 时间: '2026-07-17 08:02:00', 'T4.PV': '25.2' },
    ]);
    const bms = source('bms', ['时间', 'SOC(%)'], [
      { 时间: '2026-07-17 08:00:00', 'SOC(%)': '60' },
      { 时间: '2026-07-17 08:02:01', 'SOC(%)': '59' },
    ]);

    const session = buildPlaybackSession({
      sources: [thermal, bms],
      anchorSourceId: 'thermal',
    });
    const onlyTimestamp = parseDatasetTime('2026-07-17 08:02:00')!;
    expect(thermal.timeStats.start).toBe(parseDatasetTime('2026-07-17 08:00:00'));
    expect(session.anchorCandidateCount).toBe(1);
    expect(session.frames).toHaveLength(1);
    expect(session.range).toEqual({ start: onlyTimestamp, end: onlyTimestamp });
    expect(session.frames[0].anchorRowIndex).toBe(1);
  });

  it('乱序输入按时间稳定排序，同时保留文件原始行号作为 provenance', () => {
    const thermal = source('thermal', ['时间', 'T4.PV'], [
      { 时间: '2026-07-17 08:04:00', 'T4.PV': '26' },
      { 时间: '2026-07-17 08:00:00', 'T4.PV': '24' },
      { 时间: '2026-07-17 08:02:00', 'T4.PV': '25' },
    ]);

    const session = buildPlaybackSession({ sources: [thermal], anchorSourceId: 'thermal' });
    expect(session.frames.map((frame) => frame.timestamp)).toEqual([
      parseDatasetTime('2026-07-17 08:00:00'),
      parseDatasetTime('2026-07-17 08:02:00'),
      parseDatasetTime('2026-07-17 08:04:00'),
    ]);
    expect(session.frames.map((frame) => frame.anchorRowIndex)).toEqual([1, 2, 0]);
    expect(session.frames.map((frame) => frame.provenance.supply_water_temp.rowIndex)).toEqual([1, 2, 0]);
  });

  it('规范字段冲突时主时间轴优先，且空交集返回 null range', () => {
    const anchor = source('anchor', ['时间', 'hp_power'], [
      { 时间: '2026-07-17 08:00:00', hp_power: '1.2' },
    ]);
    const other = source('other', ['时间', 'hp_power'], [
      { 时间: '2026-07-17 08:00:01', hp_power: '9.9' },
    ]);
    const session = buildPlaybackSession({ sources: [other, anchor], anchorSourceId: 'anchor' });
    expect(session.frames[0].values.hp_power).toBe(1.2);
    expect(session.frames[0].provenance.hp_power.sourceId).toBe('anchor');

    const empty = buildPlaybackSession({
      sources: [anchor, source('far', ['时间', 'SOC(%)'], [
        { 时间: '2026-07-17 09:00:00', 'SOC(%)': '50' },
      ])],
      anchorSourceId: 'anchor',
    });
    expect(empty.frames).toEqual([]);
    expect(empty.range).toBeNull();
    expect(empty.rejectedAnchorCount).toBe(1);
  });

  it('拒绝负容差、缺失主轴和重复数据源 id', () => {
    const anchor = source('anchor', ['时间', 'hp_power'], [
      { 时间: '2026-07-17 08:00:00', hp_power: '1.2' },
    ]);
    expect(() => buildPlaybackSession({
      sources: [anchor], anchorSourceId: 'anchor', toleranceMs: -1,
    })).toThrow('时间匹配容差');
    expect(() => buildPlaybackSession({
      sources: [anchor], anchorSourceId: 'missing',
    })).toThrow('主时间轴数据源不存在');
    expect(() => buildPlaybackSession({
      sources: [anchor, anchor], anchorSourceId: 'anchor',
    })).toThrow('数据源 id 重复');
  });
});
