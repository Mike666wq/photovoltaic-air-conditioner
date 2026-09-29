import { describe, expect, it } from 'vitest';
import { normalizeDatasetHeaders, parseDatasetTime } from './dataset';

describe('公共数据集时间与表头规范化', () => {
  it('把 Excel 1900 日期序列按北京时间解释', () => {
    const excelBase = Date.UTC(1899, 11, 30);
    const shanghaiSample = Date.UTC(2026, 6, 17, 8, 0, 0);
    const serial = (shanghaiSample - excelBase) / 86_400_000;
    expect(parseDatasetTime(String(serial))).toBe(parseDatasetTime('2026-07-17 08:00:00'));
  });

  it('拒绝会被 Date 自动滚到下个月的非法日历日期', () => {
    expect(parseDatasetTime('2026-02-31 12:00:00')).toBeNull();
    expect(parseDatasetTime('2026-13-01 12:00:00')).toBeNull();
  });

  it('为空表头和重复表头生成稳定唯一键', () => {
    expect(normalizeDatasetHeaders(['时间', '', '温度', '温度', '  '])).toEqual([
      '时间', '未命名列_2', '温度', '温度_2', '未命名列_5',
    ]);
  });
});
