import type { AnalysisSource, BatteryCurrentConvention } from '../store/analysis';
import type { ExperimentBatch } from './experimentSession';
import {
  aggregatePowerEnergy,
  aggregateSignedPowerEnergy,
  buildAnalysisPoints,
  buildSeries,
  getDerivedSeries,
  selectPrimarySourceSeries,
  sumBuckets,
} from './analysisSeries';
import { buildPlaybackSession } from './playbackSession';
import { buildOperationalDiagnostics } from './operationalDiagnostics';

export type ComparisonMetricStatus = 'available' | 'missing-data' | 'needs-configuration';

export interface ComparisonMetric {
  value: number | null;
  unit: string;
  status: ComparisonMetricStatus;
  reason: string;
  sampleCount: number;
}

export type ComparisonMetricKey =
  | 'pvEnergyKwh'
  | 'systemEnergyKwh'
  | 'coolingEnergyKwh'
  | 'cop'
  | 'batteryChargeEnergyKwh'
  | 'batteryDischargeEnergyKwh';

export interface ExperimentComparisonSummary {
  batchId: string;
  batchName: string;
  sourceCount: number;
  totalRows: number;
  validRows: number;
  validRate: number | null;
  start: number | null;
  end: number | null;
  synchronizedFrameCount: number;
  rejectedAnchorCount: number;
  energyBalanceStatus: 'needs-configuration';
  metrics: Record<ComparisonMetricKey, ComparisonMetric>;
}

export interface ExperimentMetricDelta {
  key: ComparisonMetricKey;
  left: ComparisonMetric;
  right: ComparisonMetric;
  delta: number | null;
  reason: string;
}

export const COMPARISON_METRIC_LABELS: Record<ComparisonMetricKey, string> = {
  pvEnergyKwh: '光伏发电量',
  systemEnergyKwh: '系统用电量',
  coolingEnergyKwh: '供冷量',
  cop: '热泵 COP',
  batteryChargeEnergyKwh: '电池充电量',
  batteryDischargeEnergyKwh: '电池放电量',
};

function missing(unit: string, reason: string, sampleCount = 0): ComparisonMetric {
  return { value: null, unit, status: 'missing-data', reason, sampleCount };
}

function available(value: number, unit: string, sampleCount: number): ComparisonMetric {
  return { value, unit, status: 'available', reason: '', sampleCount };
}

function nativeEnergyMetric(
  points: ReturnType<typeof buildAnalysisPoints>,
  fieldKey: string,
  label: string,
): ComparisonMetric {
  const series = selectPrimarySourceSeries(buildSeries(points, fieldKey));
  if (series.length < 2) return missing('kWh', `缺少至少 2 个连续${label}功率点`, series.length);
  return available(sumBuckets(aggregatePowerEnergy(series, 'day')), 'kWh', series.length);
}

/**
 * 构造一个批次的可信摘要：单源指标按原生采样积分，跨源热工指标只读批次内严格同步帧。
 */
export function buildExperimentComparisonSummary(
  batch: ExperimentBatch,
  allSources: AnalysisSource[],
  batteryConvention: BatteryCurrentConvention,
): ExperimentComparisonSummary {
  const selected = batch.sourceIds.flatMap((id) => {
    const source = allSources.find((candidate) => candidate.id === id);
    return source ? [source] : [];
  });
  const usable = selected.map((source) => ({
    ...source,
    rows: source.processedRows.filter((row) => row.valid).map((row) => row.raw),
  }));
  const points = buildAnalysisPoints(usable);
  const totalRows = selected.reduce((sum, source) => sum + source.quality.totalRows, 0);
  const validRows = selected.reduce((sum, source) => sum + source.quality.validRows, 0);
  const starts = selected.flatMap((source) => source.prepared.timeStats.start == null ? [] : [source.prepared.timeStats.start]);
  const ends = selected.flatMap((source) => source.prepared.timeStats.end == null ? [] : [source.prepared.timeStats.end]);
  const canSynchronize = selected.length === batch.sourceIds.length && selected.length > 0;
  const session = canSynchronize
    ? buildPlaybackSession({
      sources: selected.map((source) => source.prepared),
      anchorSourceId: batch.anchorSourceId,
      toleranceMs: batch.toleranceMs,
    })
    : null;
  const diagnostics = buildOperationalDiagnostics(session?.frames ?? [], batteryConvention);

  const batteryPower = selectPrimarySourceSeries(getDerivedSeries(points, 'battery_power'));
  const batteryMetric = (direction: 'charge' | 'discharge'): ComparisonMetric => {
    if (batteryConvention === 'unknown') {
      return { value: null, unit: 'kWh', status: 'needs-configuration', reason: '尚未确认 BMS 电流正负方向', sampleCount: batteryPower.length };
    }
    if (batteryPower.length < 2) return missing('kWh', '缺少至少 2 个同源 BMS 电压/电流点', batteryPower.length);
    const positiveMeansCharge = batteryConvention === 'positive-charge';
    const sign = direction === 'charge'
      ? (positiveMeansCharge ? 'positive' : 'negative')
      : (positiveMeansCharge ? 'negative' : 'positive');
    return available(sumBuckets(aggregateSignedPowerEnergy(batteryPower, sign, 'day')), 'kWh', batteryPower.length);
  };

  const cooling = diagnostics.commonThermalSampleCount >= 2
    ? available(diagnostics.coolingEnergyKwh, 'kWh', diagnostics.commonThermalSampleCount)
    : missing('kWh', '需要同一严格同步帧内连续的流量、送水温度、回水温度和热泵功率', diagnostics.commonThermalSampleCount);
  const cop = diagnostics.commonThermalSampleCount >= 2 && diagnostics.cop != null
    ? available(diagnostics.cop, '', diagnostics.commonThermalSampleCount)
    : missing('', '严格同步帧不足，无法计算供冷量/热泵耗电量', diagnostics.commonThermalSampleCount);

  return {
    batchId: batch.id,
    batchName: batch.name,
    sourceCount: selected.length,
    totalRows,
    validRows,
    validRate: totalRows ? validRows / totalRows : null,
    start: starts.length ? Math.min(...starts) : null,
    end: ends.length ? Math.max(...ends) : null,
    synchronizedFrameCount: session?.frames.length ?? 0,
    rejectedAnchorCount: session?.rejectedAnchorCount ?? 0,
    energyBalanceStatus: 'needs-configuration',
    metrics: {
      pvEnergyKwh: nativeEnergyMetric(points, 'pv_power', '光伏'),
      systemEnergyKwh: nativeEnergyMetric(points, 'system_active_power', '系统'),
      coolingEnergyKwh: cooling,
      cop,
      batteryChargeEnergyKwh: batteryMetric('charge'),
      batteryDischargeEnergyKwh: batteryMetric('discharge'),
    },
  };
}

/** 任一侧不可用时不制造 0 差异。 */
export function compareExperimentSummaries(
  left: ExperimentComparisonSummary,
  right: ExperimentComparisonSummary,
): ExperimentMetricDelta[] {
  return (Object.keys(COMPARISON_METRIC_LABELS) as ComparisonMetricKey[]).map((key) => {
    const leftMetric = left.metrics[key];
    const rightMetric = right.metrics[key];
    const comparable = leftMetric.status === 'available' && rightMetric.status === 'available'
      && leftMetric.value != null && rightMetric.value != null;
    return {
      key,
      left: leftMetric,
      right: rightMetric,
      delta: comparable ? rightMetric.value! - leftMetric.value! : null,
      reason: comparable ? '' : [leftMetric.reason, rightMetric.reason].filter(Boolean).join('；') || '指标不可比较',
    };
  });
}
