import { MonitoringTrendChart } from './MonitoringTrendChart';

/** BMS兼容封装；共用图表保留实际观测与会话边界。 */
export function BmsTrendChart({ title, unit, color: _color, points }: {
  title: string;
  unit: string;
  color: string;
  points: { capturedUtc: string; value: number | null; connectionSessionId?: string; session?: string }[];
  localTime?: boolean;
}) {
  return <MonitoringTrendChart title={title} unit={unit} series={[{
    id: title,
    name: title,
    unit,
    points: points.map(point => ({ time: point.capturedUtc, value: point.value, session: point.session ?? point.connectionSessionId ?? 'unknown' })),
  }]} emptyText="等待本地采样后显示最近一小时趋势" />;
}
