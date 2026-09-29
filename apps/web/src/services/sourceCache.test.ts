import { beforeEach, describe, expect, it } from 'vitest';
import type { PreparedDataSource } from './dataSourcePipeline';
import {
  clearSourceCache,
  getCachedSource,
  getCachedSources,
  getSourceCacheDiagnostics,
  putCachedSource,
  putCachedSources,
  removeCachedSource,
} from './sourceCache';

function source(id: string, value: string): PreparedDataSource {
  const raw = { 时间: '2026-07-17 08:00:00', 'SOC(%)': value };
  return {
    id,
    filename: `${id}.xlsx`,
    format: 'xlsx',
    headers: ['时间', 'SOC(%)'],
    rows: [raw],
    profile: {
      kind: 'battery-bms',
      label: '电池 BMS 数据',
      capabilities: ['电池 BMS'],
      fieldKeys: ['battery_soc'],
    },
    fieldMappings: [{ sourceColumn: 'SOC(%)', fieldKey: 'battery_soc', confidence: 'exact-alias' }],
    timeStats: {
      timeColumn: '时间',
      start: 1,
      end: 1,
      validTimestampCount: 1,
      invalidTimestampCount: 0,
      uniqueTimestampCount: 1,
      duplicateTimestampCount: 0,
      medianIntervalMs: null,
      minimumIntervalMs: null,
      maximumIntervalMs: null,
      gapCount: 0,
    },
    quality: {
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      invalidFieldCount: 0,
      issueCounts: {},
    },
    processedRows: [{
      rowIndex: 0,
      raw,
      timestamp: 1,
      valid: true,
      invalidFields: [],
      issues: [],
    }],
  };
}

describe('PreparedDataSource 缓存的 Node 内存回退', () => {
  beforeEach(async () => {
    await clearSourceCache();
  });

  it('IndexedDB 不可用时 put/get 仍立即返回当前会话中的同一数据源', async () => {
    const prepared = source('source-a', '52');
    await putCachedSource(prepared);

    expect(await getCachedSource(prepared.id)).toBe(prepared);
    expect(getSourceCacheDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'open', code: 'indexeddb-unavailable' }),
    ]));
  });

  it('批量写入和读取按输入顺序返回命中项，并清晰列出缺失 key', async () => {
    const first = source('source-a', '52');
    const second = source('source-b', '67');
    await putCachedSources([first, second]);

    const result = await getCachedSources(['source-b', 'missing', 'source-a']);
    expect(result.found).toEqual([second, first]);
    expect(result.missingKeys).toEqual(['missing']);
  });

  it('remove 只删除指定数据源', async () => {
    const first = source('source-a', '52');
    const second = source('source-b', '67');
    await putCachedSources([first, second]);

    await removeCachedSource(first.id);

    expect(await getCachedSource(first.id)).toBeNull();
    expect(await getCachedSource(second.id)).toBe(second);
  });

  it('clear 清空全部内存回退数据', async () => {
    await putCachedSources([source('source-a', '52'), source('source-b', '67')]);

    await clearSourceCache();

    expect(await getCachedSources(['source-a', 'source-b'])).toEqual({
      found: [],
      missingKeys: ['source-a', 'source-b'],
    });
  });
});
