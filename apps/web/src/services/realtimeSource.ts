import type { MonitoringTrendSeries } from '../components/bmsRealtime/MonitoringTrendChart';

export const sourceLabel = (source?: string) => source === 'simulation' ? '模拟来源（客户端声明）' : source === 'serial' ? '串口来源（客户端声明）' : '尚未采集';

/** 接收顺序选择当前来源，不能以客户端壁钟或分区遍历顺序替代。 */
export function latestByChannel<T extends { acceptedOrder: number }>(samples: T[], channel: (sample: T) => string): T[] {
  const latest = new Map<string, T>();
  for (const sample of samples) {
    const key = channel(sample), previous = latest.get(key);
    if (!previous || sample.acceptedOrder > previous.acceptedOrder) latest.set(key, sample);
  }
  return [...latest.values()];
}

/** 先沿完整历史识别来源翻转，再拆线；串口→模拟→串口不得重新连线。 */
export function sourceTrendLines(title: string, unit: string, points: Array<{ time: string; value: number | null; source: string; session: string }>): MonitoringTrendSeries[] {
  const lines = new Map<string, MonitoringTrendSeries>();
  let previous: string | undefined, segment = 0;
  for (const point of points) {
    const boundary = `${point.source}/${point.session}`;
    if (boundary !== previous) segment++;
    previous = boundary;
    let line = lines.get(point.source);
    if (!line) {
      line = { id: `${title}/${point.source}`, name: `${title} · ${sourceLabel(point.source)}`, unit, points: [] };
      lines.set(point.source, line);
    }
    line.points.push({ time: point.time, value: point.value, session: `${boundary}/${segment}` });
  }
  return [...lines.values()];
}
