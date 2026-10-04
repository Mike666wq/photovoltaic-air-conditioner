import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import './monitoring-trend-chart.css';

export interface MonitoringTrendPoint {
  time: string;
  value: number | null;
  session: string;
}

export interface MonitoringTrendSeries {
  id: string;
  name: string;
  unit: string;
  points: MonitoringTrendPoint[];
}

export interface MonitoringTrendChartProps {
  title: string;
  unit: string;
  series: MonitoringTrendSeries[];
  retentionMs?: number;
  gapMs?: number;
  emptyText?: string;
}

export interface BuiltTrendSeries {
  id: string;
  name: string;
  data: Array<[number, number | null]>;
}

/** 保留全部观测，只在空值、会话切换和时间间隔处插入仅用于绘图的空断点。 */
export function buildTrendSeries(series: MonitoringTrendSeries[], gapMs = 30_000): BuiltTrendSeries[] {
  return series.map((line) => {
    const points = line.points
      .map((point, index) => ({ point, index, time: Date.parse(point.time) }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((a, b) => a.time - b.time || a.index - b.index);
    const data: Array<[number, number | null]> = [];
    let previous: (typeof points)[number] | undefined;

    for (const current of points) {
      const hasBoundary = previous != null && (
        previous.point.session !== current.point.session || current.time - previous.time > gapMs
      );
      if (current.point.value == null) {
        data.push([current.time, null]);
      } else {
        if (hasBoundary) data.push([current.time, null]);
        data.push([current.time, current.point.value]);
      }
      previous = current;
    }
    return { id: line.id, name: line.name, data };
  });
}

interface TimeWindow { start: number; end: number }
interface ChartModel extends MonitoringTrendChartProps {
  retentionMs: number;
  gapMs: number;
  compatible: boolean;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));

function localDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { hour12: false });
}

function localTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}

function latestTimestamp(series: MonitoringTrendSeries[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const line of series) for (const point of line.points) {
    const timestamp = Date.parse(point.time);
    if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
  }
  return latest;
}

function safeTooltip(params: unknown, title: string, unit: string): string {
  const rows = Array.isArray(params) ? params : [params];
  const first = rows[0] as { value?: unknown } | undefined;
  const firstValue = Array.isArray(first?.value) ? Number(first.value[0]) : NaN;
  if (!Number.isFinite(firstValue)) return '';
  const lines = rows.map((raw) => {
    const item = raw as { seriesName?: string; value?: unknown; color?: string };
    const value = Array.isArray(item.value) ? item.value[1] : null;
    const label = escapeHtml(String(item.seriesName ?? title));
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
    const color = /^#[0-9a-f]{3,8}$/i.test(item.color ?? '') ? item.color! : '#64748b';
    return `<div class="monitoring-trend-tooltip__row"><i style="background:${color}"></i><span>${label}：${numeric} ${escapeHtml(unit)}</span></div>`;
  }).join('');
  return `<div class="monitoring-trend-tooltip"><strong>${escapeHtml(title)} · ${escapeHtml(localDateTime(firstValue))}</strong>${lines}</div>`;
}

export function MonitoringTrendChart({
  title,
  unit,
  series,
  retentionMs = 60 * 60 * 1000,
  gapMs = 30_000,
  emptyText = '等待采样后显示趋势',
}: MonitoringTrendChartProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const modelRef = useRef<ChartModel | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const frozenWindowRef = useRef<TimeWindow | null>(null);
  const applyingOptionRef = useRef(false);
  const legendSelectionRef = useRef<Record<string, boolean>>({});
  const [viewingHistory, setViewingHistory] = useState(false);

  const compatible = series.every((line) => line.unit === unit);
  modelRef.current = { title, unit, series, retentionMs, gapMs, emptyText, compatible };

  renderRef.current = () => {
    const element = elementRef.current;
    const model = modelRef.current;
    if (!element || !model || element.clientWidth <= 0 || element.clientHeight <= 0) return;

    if (!chartRef.current || chartRef.current.isDisposed()) {
      chartRef.current = echarts.init(element, undefined, { renderer: 'canvas' });
      chartRef.current.on('legendselectchanged', (payload: unknown) => {
        const selected = (payload as { selected?: Record<string, boolean> }).selected;
        if (selected) legendSelectionRef.current = { ...selected };
      });
      chartRef.current.on('datazoom', () => {
        if (applyingOptionRef.current) return;
        const zoom = chartRef.current?.getOption().dataZoom as Array<{ startValue?: unknown; endValue?: unknown }> | undefined;
        const start = Number(zoom?.[0]?.startValue);
        const end = Number(zoom?.[0]?.endValue);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          frozenWindowRef.current = { start, end };
          setViewingHistory(true);
        }
      });
    }

    const chart = chartRef.current;
    chart.resize();
    const retention = Math.max(1, model.retentionMs);
    // 即使设备最新观测较早，实时窗口末端仍跟随当前墙钟时间。
    const dataEnd = latestTimestamp(model.compatible ? model.series : []);
    const liveEnd = Math.max(Date.now(), Number.isFinite(dataEnd) ? dataEnd : Date.now());
    const liveWindow = { start: liveEnd - retention, end: liveEnd };
    const window = frozenWindowRef.current ?? liveWindow;
    // 坐标轴涵盖完整保留域，并在冻结视窗位于域外时扩展；slider仍可浏览域内其它时间。
    const domain = frozenWindowRef.current
      ? { start: Math.min(liveWindow.start, window.start), end: Math.max(liveWindow.end, window.end) }
      : liveWindow;
    const built = buildTrendSeries(model.compatible ? model.series : [], model.gapMs);
    const hasData = built.some((line) => line.data.some((point) => point[1] != null));
    const legendSelected = Object.fromEntries(built.map((line) => [
      line.name,
      legendSelectionRef.current[line.name] ?? true,
    ]));

    const option: EChartsOption = {
      animation: false,
      grid: { left: 62, right: 20, top: 54, bottom: 104, containLabel: false },
      legend: {
        type: 'scroll',
        top: 8,
        left: 12,
        right: 12,
        itemWidth: 12,
        itemHeight: 8,
        pageIconSize: 10,
        selected: legendSelected,
        textStyle: { color: '#526176', fontSize: 11 },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'line' },
        formatter: (params: unknown) => safeTooltip(params, model.title, model.unit),
      },
      xAxis: {
        type: 'time',
        min: domain.start,
        max: domain.end,
        splitNumber: 4,
        axisLabel: { color: '#68788e', hideOverlap: true, formatter: (value: number) => localTime(value) },
        axisLine: { lineStyle: { color: '#d8e0eb' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: `${model.title}（${model.unit}）`,
        nameLocation: 'middle',
        nameGap: 44,
        scale: true,
        nameTextStyle: { color: '#526176', fontSize: 11 },
        axisLabel: { color: '#68788e', hideOverlap: true },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: '#edf1f6' } },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, startValue: window.start, endValue: window.end, filterMode: 'none' },
        { type: 'slider', xAxisIndex: 0, height: 16, bottom: 20, showDetail: false, brushSelect: false, startValue: window.start, endValue: window.end, filterMode: 'none' },
      ],
      series: built.map((line) => ({
        id: line.id,
        name: line.name,
        type: 'line' as const,
        data: line.data,
        connectNulls: false,
        showSymbol: line.data.filter((point) => point[1] != null).length === 1,
        symbolSize: 5,
        lineStyle: { width: 2 },
        emphasis: { focus: 'series' },
      })),
    };
    applyingOptionRef.current = true;
    try {
      chart.setOption(option, { notMerge: true, lazyUpdate: false });
    } finally {
      applyingOptionRef.current = false;
    }
    element.dataset.hasData = String(hasData);
  };

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => renderRef.current());
    observer.observe(element);
    renderRef.current();
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => { renderRef.current(); }, [title, unit, series, retentionMs, gapMs]);

  const hasData = compatible && series.some((line) => line.points.some((point) => point.value != null && Number.isFinite(point.value)));
  const message = compatible ? emptyText : '序列单位不一致，已停止绘制以避免混用坐标轴';

  return <section className="monitoring-trend-card">
    <header className="monitoring-trend-card__head">
      <h2>{title}</h2>
      {viewingHistory && <div className="monitoring-trend-card__history" role="status">
        <span>历史查看中</span>
        <button type="button" onClick={() => { frozenWindowRef.current = null; setViewingHistory(false); renderRef.current(); }}>回到实时</button>
      </div>}
    </header>
    <div className="monitoring-trend-card__body">
      <div ref={elementRef} className="monitoring-trend-card__chart" role="img" aria-label={`${title}趋势，纵轴单位${unit}`} />
      {!hasData && <div className="monitoring-trend-card__empty">{message}</div>}
    </div>
    <p className="monitoring-trend-card__caption">最近 {Math.round(retentionMs / 60_000)} 分钟 · 本地时间</p>
  </section>;
}
