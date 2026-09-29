import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPERIMENT_TOLERANCE_MS,
  ExperimentBatchValidationError,
  createExperimentBatch,
  normalizeExperimentBatch,
  replaceBatchSources,
  updateExperimentBatchConfig,
  validateExperimentBatch,
} from './experimentSession';

const CREATED_AT = '2026-07-17T00:00:00.000Z';
const UPDATED_AT = '2026-07-17T01:00:00.000Z';

describe('试验批次领域模型', () => {
  it('创建时稳定去重来源，并默认使用首源与 2 秒容差', () => {
    const batch = createExperimentBatch({
      id: ' batch-0717 ',
      name: ' 7 月 17 日联合试验 ',
      sourceIds: [' thermal ', 'bms', 'thermal', '', ' bms '],
      timestamp: CREATED_AT,
    });

    expect(batch).toEqual({
      id: 'batch-0717',
      name: '7 月 17 日联合试验',
      sourceIds: ['thermal', 'bms'],
      anchorSourceId: 'thermal',
      toleranceMs: DEFAULT_EXPERIMENT_TOLERANCE_MS,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  });

  it('允许显式设置主时间轴和边界内的同步容差', () => {
    const batch = createExperimentBatch({
      id: 'batch-1',
      name: 'BMS 主轴试验',
      sourceIds: ['thermal', 'bms'],
      anchorSourceId: 'bms',
      toleranceMs: 60_000,
      timestamp: CREATED_AT,
    });

    expect(batch.anchorSourceId).toBe('bms');
    expect(batch.toleranceMs).toBe(60_000);
    expect(validateExperimentBatch(batch)).toBe(batch);
  });

  it('拒绝空来源、列表外主源和越界容差', () => {
    expect(() => createExperimentBatch({
      id: 'empty', name: '空批次', sourceIds: [], timestamp: CREATED_AT,
    })).toThrow(/至少需要一个数据源/);

    expect(() => createExperimentBatch({
      id: 'bad-anchor', name: '错误主源', sourceIds: ['thermal'],
      anchorSourceId: 'bms', timestamp: CREATED_AT,
    })).toThrow(/主时间轴必须属于/);

    for (const toleranceMs of [-1, 60_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createExperimentBatch({
        id: 'bad-tolerance', name: '错误容差', sourceIds: ['thermal'],
        toleranceMs, timestamp: CREATED_AT,
      })).toThrow(ExperimentBatchValidationError);
    }
  });

  it('normalize 不会偷偷修复非法主源，validate 会明确拒绝', () => {
    const normalized = normalizeExperimentBatch({
      id: ' batch ', name: ' 批次 ', sourceIds: [' a ', 'a', ' b '],
      anchorSourceId: ' missing ', toleranceMs: 2_000,
      createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    });

    expect(normalized.sourceIds).toEqual(['a', 'b']);
    expect(normalized.anchorSourceId).toBe('missing');
    expect(() => validateExperimentBatch(normalized)).toThrow(/主时间轴必须属于/);
  });

  it('替换来源时保留仍存在的旧主源，否则回退到首个新来源', () => {
    const original = createExperimentBatch({
      id: 'batch', name: '批次', sourceIds: ['thermal', 'bms'],
      anchorSourceId: 'thermal', timestamp: CREATED_AT,
    });

    const preserved = replaceBatchSources(original, ['aux', 'thermal', 'aux'], {
      updatedAt: UPDATED_AT,
    });
    expect(preserved.sourceIds).toEqual(['aux', 'thermal']);
    expect(preserved.anchorSourceId).toBe('thermal');
    expect(preserved.updatedAt).toBe(UPDATED_AT);

    const fallback = replaceBatchSources(original, ['bms', 'aux'], {
      updatedAt: UPDATED_AT,
    });
    expect(fallback.anchorSourceId).toBe('bms');
    expect(original.sourceIds).toEqual(['thermal', 'bms']);
  });

  it('替换来源和更新配置均维持批次不变量', () => {
    const original = createExperimentBatch({
      id: 'batch', name: '批次', sourceIds: ['thermal', 'bms'],
      timestamp: CREATED_AT,
    });

    expect(() => replaceBatchSources(original, ['thermal'], {
      anchorSourceId: 'bms', updatedAt: UPDATED_AT,
    })).toThrow(/主时间轴必须属于/);

    const updated = updateExperimentBatchConfig(original, {
      name: ' 新名称 ',
      anchorSourceId: 'bms',
      toleranceMs: 500,
      updatedAt: UPDATED_AT,
    });
    expect(updated).toMatchObject({
      name: '新名称', anchorSourceId: 'bms', toleranceMs: 500,
      createdAt: CREATED_AT, updatedAt: UPDATED_AT,
    });
    expect(original.name).toBe('批次');
  });
});
