import type { BatteryCurrentConvention } from '../store/analysis';
import type { PlaybackFrame } from './playbackSession';
import {
  aggregatePowerEnergy,
  aggregateSignedPowerEnergy,
  sumBuckets,
  type SeriesPoint,
} from './analysisSeries';

export type DiagnosticSeverity = 'info' | 'warning' | 'critical';
export type EnergyBalanceStatus = 'needs-configuration' | 'ready' | 'missing-data';

export interface OperationalDiagnosticOptions {
  /** 只有用户明确确认各功率字段的正负号与系统边界后，才允许计算能量平衡。 */
  energyBalanceConfirmed?: boolean;
}

export interface DiagnosticEvent {
  code: 'energy_balance' | 'hp_without_flow' | 'grid_power_offline' | 'soc_low' | 'soc_high';
  severity: DiagnosticSeverity;
  start: number;
  end: number;
  count: number;
  message: string;
}

export interface OperationalDiagnosticSummary {
  frameCount: number;
  balanceSampleCount: number;
  balanceCoverage: number;
  energyBalanceStatus: EnergyBalanceStatus;
  energyBalanceReason: string;
  meanAbsoluteBalanceKw: number | null;
  maximumAbsoluteBalanceKw: number | null;
  commonThermalSampleCount: number;
  coolingEnergyKwh: number;
  heatPumpEnergyKwh: number;
  cop: number | null;
  batteryChargeEnergyKwh: number;
  batteryDischargeEnergyKwh: number;
  batteryPowerSampleCount: number;
  estimatedBatteryCapacityKwh: number | null;
  equivalentFullCycles: number | null;
  lowSocHours: number;
  events: DiagnosticEvent[];
}

function medianInterval(frames: PlaybackFrame[]): number {
  const intervals = frames.slice(1)
    .map((frame, index) => frame.timestamp - frames[index].timestamp)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  return intervals[Math.floor(intervals.length / 2)] ?? 0;
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 诊断只读严格同步帧，不推测缺失字段，也不反向改变原理图控制状态。 */
export function buildOperationalDiagnostics(
  frames: PlaybackFrame[],
  batteryConvention: BatteryCurrentConvention,
  options: OperationalDiagnosticOptions = {},
): OperationalDiagnosticSummary {
  const ordered = [...frames].sort((left, right) => left.timestamp - right.timestamp);
  const balanceResiduals: number[] = [];
  const coolingSeries: SeriesPoint[] = [];
  const hpCommonSeries: SeriesPoint[] = [];
  const batteryPowerSeries: SeriesPoint[] = [];
  const capacitySamples: number[] = [];
  const events: DiagnosticEvent[] = [];
  const typicalInterval = medianInterval(ordered);
  const eventJoinWindow = Math.max(2_000, typicalInterval * 3);

  const record = (
    code: DiagnosticEvent['code'],
    severity: DiagnosticSeverity,
    timestamp: number,
    message: string,
  ) => {
    for (let index = events.length - 1; index >= 0; index--) {
      const previous = events[index];
      if (previous.code !== code) continue;
      if (timestamp - previous.end <= eventJoinWindow) {
        previous.end = timestamp;
        previous.count += 1;
        const rank: Record<DiagnosticSeverity, number> = { info: 0, warning: 1, critical: 2 };
        if (rank[severity] > rank[previous.severity]) previous.severity = severity;
        previous.message = message;
        return;
      }
      break;
    }
    events.push({ code, severity, start: timestamp, end: timestamp, count: 1, message });
  };

  for (const frame of ordered) {
    const values = frame.values;
    const batteryElectricalKw = finite(values.battery_voltage) && finite(values.battery_current)
      ? values.battery_voltage * values.battery_current / 1000
      : null;
    const batteryToBusKw = batteryElectricalKw == null || batteryConvention === 'unknown'
      ? null
      : batteryConvention === 'positive-charge' ? -batteryElectricalKw : batteryElectricalKw;

    if (options.energyBalanceConfirmed && finite(values.pv_power) && finite(values.grid_active_power)
      && finite(values.system_active_power) && batteryToBusKw != null) {
      const residual = values.pv_power + values.grid_active_power + batteryToBusKw - values.system_active_power;
      const absoluteResidual = Math.abs(residual);
      balanceResiduals.push(absoluteResidual);
      const threshold = Math.max(0.5, Math.abs(values.system_active_power) * 0.25);
      if (absoluteResidual > threshold) {
        record('energy_balance', absoluteResidual > threshold * 2 ? 'critical' : 'warning', frame.timestamp,
          `能量平衡残差 ${residual.toFixed(2)} kW，超过当前阈值 ${threshold.toFixed(2)} kW`);
      }
    }

    if (finite(values.hp_power) && Math.abs(values.hp_power) > 0.05
      && finite(values.water_flow) && Math.abs(values.water_flow) <= 0.01) {
      record('hp_without_flow', 'critical', frame.timestamp, '热泵存在功率，但同步帧水流量接近 0');
    }
    if (finite(values.grid_active_power) && Math.abs(values.grid_active_power) > 0.1
      && finite(values.grid_voltage) && Math.abs(values.grid_voltage) < 50) {
      record('grid_power_offline', 'critical', frame.timestamp, '市电有功功率非零，但市电电压低于在线阈值');
    }
    if (finite(values.battery_soc) && values.battery_soc < 15) {
      record('soc_low', values.battery_soc < 8 ? 'critical' : 'warning', frame.timestamp, `电池 SOC 偏低（${values.battery_soc.toFixed(1)}%）`);
    }
    if (finite(values.battery_soc) && values.battery_soc > 95) {
      record('soc_high', 'info', frame.timestamp, `电池 SOC 处于高位（${values.battery_soc.toFixed(1)}%）`);
    }

    if (finite(values.water_flow) && finite(values.supply_water_temp)
      && finite(values.return_water_temp) && finite(values.hp_power)) {
      coolingSeries.push({
        timestamp: frame.timestamp,
        value: 1.163 * Math.abs(values.water_flow) * Math.abs(values.return_water_temp - values.supply_water_temp),
        sourceId: 'strict-common-window',
      });
      hpCommonSeries.push({ timestamp: frame.timestamp, value: Math.abs(values.hp_power), sourceId: 'strict-common-window' });
    }
    if (batteryElectricalKw != null && batteryConvention !== 'unknown') {
      const conventionPower = batteryConvention === 'positive-charge' ? batteryElectricalKw : -batteryElectricalKw;
      batteryPowerSeries.push({ timestamp: frame.timestamp, value: conventionPower, sourceId: 'battery-common-window' });
    }
    if (finite(values.battery_voltage) && finite(values.battery_full_capacity_ah)) {
      capacitySamples.push(values.battery_voltage * values.battery_full_capacity_ah / 1000);
    }
  }

  let lowSocMs = 0;
  const lowSocGapLimit = Math.max(5 * 60_000, typicalInterval * 3);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const duration = ordered[index].timestamp - previous.timestamp;
    if (duration > 0 && duration <= lowSocGapLimit
      && finite(previous.values.battery_soc) && previous.values.battery_soc < 20) lowSocMs += duration;
  }

  const coolingEnergyKwh = sumBuckets(aggregatePowerEnergy(coolingSeries, 'day'));
  const heatPumpEnergyKwh = sumBuckets(aggregatePowerEnergy(hpCommonSeries, 'day'));
  const batteryChargeEnergyKwh = batteryConvention === 'unknown'
    ? 0
    : sumBuckets(aggregateSignedPowerEnergy(batteryPowerSeries, 'positive', 'day'));
  const batteryDischargeEnergyKwh = batteryConvention === 'unknown'
    ? 0
    : sumBuckets(aggregateSignedPowerEnergy(batteryPowerSeries, 'negative', 'day'));
  const estimatedBatteryCapacityKwh = capacitySamples.length
    ? capacitySamples.reduce((sum, value) => sum + value, 0) / capacitySamples.length
    : null;
  const energyBalanceStatus: EnergyBalanceStatus = !options.energyBalanceConfirmed
    ? 'needs-configuration'
    : balanceResiduals.length ? 'ready' : 'missing-data';
  const energyBalanceReason = energyBalanceStatus === 'needs-configuration'
    ? '尚未确认 PV、市电、系统功率与电池功率的计量边界和正负号，已禁止自动生成平衡告警。'
    : energyBalanceStatus === 'missing-data'
      ? (batteryConvention === 'unknown'
        ? 'BMS 电流正负方向尚未确认，无法形成可信能量平衡。'
        : '严格共同时间窗内缺少能量平衡所需的完整字段。')
      : '已按用户确认的计量边界和正负号计算。';

  return {
    frameCount: ordered.length,
    balanceSampleCount: balanceResiduals.length,
    balanceCoverage: ordered.length ? balanceResiduals.length / ordered.length : 0,
    energyBalanceStatus,
    energyBalanceReason,
    meanAbsoluteBalanceKw: balanceResiduals.length
      ? balanceResiduals.reduce((sum, value) => sum + value, 0) / balanceResiduals.length
      : null,
    maximumAbsoluteBalanceKw: balanceResiduals.length ? Math.max(...balanceResiduals) : null,
    commonThermalSampleCount: coolingSeries.length,
    coolingEnergyKwh,
    heatPumpEnergyKwh,
    cop: heatPumpEnergyKwh > 0 ? coolingEnergyKwh / heatPumpEnergyKwh : null,
    batteryChargeEnergyKwh,
    batteryDischargeEnergyKwh,
    batteryPowerSampleCount: batteryPowerSeries.length,
    estimatedBatteryCapacityKwh,
    equivalentFullCycles: estimatedBatteryCapacityKwh && estimatedBatteryCapacityKwh > 0
      ? (batteryChargeEnergyKwh + batteryDischargeEnergyKwh) / (2 * estimatedBatteryCapacityKwh)
      : null,
    lowSocHours: lowSocMs / 3_600_000,
    events,
  };
}
