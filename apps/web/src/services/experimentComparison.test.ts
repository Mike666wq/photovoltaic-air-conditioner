import { describe, expect, it } from 'vitest';
import { prepareDataSource } from './dataSourcePipeline';
import type { AnalysisSource } from '../store/analysis';
import type { ExperimentBatch } from './experimentSession';
import { buildExperimentComparisonSummary, compareExperimentSummaries } from './experimentComparison';

function analysisSource(id: string, rows: Array<Record<string, string>>): AnalysisSource {
  const headers = Object.keys(rows[0]);
  const prepared = prepareDataSource({ id, filename: `${id}.xlsx`, format: 'xlsx', headers, rows, timeColumn: '时间' });
  return {
    id, sourceFile: prepared.filename, format: 'xlsx', headers, rows,
    timeColumn: '时间', importedAt: '2026-07-17T00:00:00.000Z', profile: prepared.profile,
    quality: prepared.quality, processedRows: prepared.processedRows, prepared,
  };
}

const batch = (sourceIds: string[]): ExperimentBatch => ({
  id: 'batch', name: 'A', sourceIds, anchorSourceId: sourceIds[0], toleranceMs: 2_000,
  createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
});

describe('实验批次 A/B 指标', () => {
  it('单源功率按原生时间序列积分，缺失跨源热工字段不显示 0', () => {
    const source = analysisSource('thermal', [
      { 时间: '2026-07-17 08:00:00', 'ZW66822.PV': '2', 'D3.PV': '1' },
      { 时间: '2026-07-17 09:00:00', 'ZW66822.PV': '2', 'D3.PV': '1' },
    ]);
    const summary = buildExperimentComparisonSummary(batch(['thermal']), [source], 'positive-charge');
    expect(summary.metrics.pvEnergyKwh).toMatchObject({ status: 'available', value: 2 });
    expect(summary.metrics.systemEnergyKwh).toMatchObject({ status: 'available', value: 1 });
    expect(summary.metrics.coolingEnergyKwh).toMatchObject({ status: 'missing-data', value: null });
    expect(summary.energyBalanceStatus).toBe('needs-configuration');
  });

  it('BMS 方向未确认时充放电指标明确需要配置', () => {
    const source = analysisSource('bms', [
      { 时间: '2026-07-17 08:00:00', '电压(V)': '50', '电流(A)': '2', 'SOC(%)': '60' },
      { 时间: '2026-07-17 09:00:00', '电压(V)': '50', '电流(A)': '2', 'SOC(%)': '61' },
    ]);
    const summary = buildExperimentComparisonSummary(batch(['bms']), [source], 'unknown');
    expect(summary.metrics.batteryChargeEnergyKwh).toMatchObject({ status: 'needs-configuration', value: null });
  });

  it('任一批次缺值时差值保持 null', () => {
    const present = analysisSource('present', [
      { 时间: '2026-07-17 08:00:00', 'ZW66822.PV': '2' },
      { 时间: '2026-07-17 09:00:00', 'ZW66822.PV': '2' },
    ]);
    const missing = analysisSource('missing', [
      { 时间: '2026-07-17 08:00:00', 'T4.PV': '12' },
      { 时间: '2026-07-17 09:00:00', 'T4.PV': '13' },
    ]);
    const left = buildExperimentComparisonSummary(batch(['present']), [present], 'positive-charge');
    const right = buildExperimentComparisonSummary({ ...batch(['missing']), id: 'right' }, [missing], 'positive-charge');
    const pv = compareExperimentSummaries(left, right).find((item) => item.key === 'pvEnergyKwh');
    expect(pv).toMatchObject({ delta: null });
    expect(pv?.reason).toContain('缺少');
  });
});
