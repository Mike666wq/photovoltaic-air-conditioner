import { MonitoringTrendChart } from './MonitoringTrendChart';
import { sourceTrendLines } from '../../services/realtimeSource';
import type { BmsSnapshot } from '../../services/bmsRealtimeTypes';

export interface BmsChartPoint {
  capturedUtc: string;
  value: number | null;
  connectionSessionId?: string;
  session?: string;
  source?: BmsSnapshot['source'];
}

/** BMS来源拆线显示，会话或来源翻转都会形成独立断点。 */
export function buildBmsTrendLines(title: string, unit: string, points: BmsChartPoint[]) {
  return sourceTrendLines(title, unit, points.map(point => ({
    time: point.capturedUtc, value: point.value, source: point.source ?? 'serial',
    session: point.session ?? point.connectionSessionId ?? 'unknown',
  })));
}

/** BMS兼容封装；来源与连接会话分段后交给共用图表。 */
export function BmsTrendChart({ title, unit, points }: {
  title: string;
  unit: string;
  color: string;
  points: BmsChartPoint[];
  localTime?: boolean;
}) {
  return <MonitoringTrendChart title={title} unit={unit} series={buildBmsTrendLines(title, unit, points)} emptyText="等待本地采样后显示最近一小时趋势" />;
}
