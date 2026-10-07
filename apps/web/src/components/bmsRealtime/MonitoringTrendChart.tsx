import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import './monitoring-trend-chart.css';

export interface MonitoringTrendPoint {
  time: string;
  value: number | null;
  session: string;
  /** BMS逐点声明的采集周期；实验源或旧API可省略。 */
  periodSeconds?: number | null;
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
  showWindowControls?: boolean;
}

export interface BuiltTrendSeries {
  id: string;
  name: string;
  data: Array<[number, number | null]>;
  /** 仅单点分段需要标记，密集曲线保持无标记。 */
  isolatedPointIndices: number[];
}

export type TrendWindowMode = 'auto' | '5m' | '15m' | '30m' | '60m';

const TREND_WINDOW_MS: Record<Exclude<TrendWindowMode, 'auto'>, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': 60 * 60_000,
};

export interface TrendDataStats {
  validCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  coverageMs: number;
  declaredPeriodMs: number | null;
}

export function trendDataStats(series: MonitoringTrendSeries[]): TrendDataStats {
  const timestamps: number[] = [];
  const periods: number[] = [];
  for (const line of series) for (const point of line.points) {
    const timestamp = Date.parse(point.time);
    if (point.value != null && Number.isFinite(point.value) && Number.isFinite(timestamp)) timestamps.push(timestamp);
    const period = validPeriodMs(point.periodSeconds);
    if (period) periods.push(period);
  }
  timestamps.sort((a, b) => a - b);
  const firstTimestamp = timestamps[0] ?? null;
  const lastTimestamp = timestamps.length ? timestamps[timestamps.length - 1] : null;
  return {
    validCount: timestamps.length,
    firstTimestamp,
    lastTimestamp,
    coverageMs: firstTimestamp != null && lastTimestamp != null ? Math.max(0, lastTimestamp - firstTimestamp) : 0,
    declaredPeriodMs: periods.length ? Math.max(...periods) : null,
  };
}

export function resolveTrendWindowMs(mode: TrendWindowMode, stats: TrendDataStats, retentionMs: number): number {
  const retention = Math.max(1, retentionMs);
  if (mode !== 'auto') return Math.min(retention, TREND_WINDOW_MS[mode]);
  const minimum = Math.min(retention, TREND_WINDOW_MS['5m']);
  const target = Math.max(minimum, stats.coverageMs * 1.25, (stats.declaredPeriodMs ?? 0) * 3);
  const presets = [TREND_WINDOW_MS['5m'], TREND_WINDOW_MS['15m'], TREND_WINDOW_MS['30m'], TREND_WINDOW_MS['60m']];
  return Math.min(retention, presets.find(windowMs => windowMs >= target) ?? retention);
}

function validPeriodMs(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

/** 保留全部观测；周期按观测逐点解释，周期缺失时沿用通用间隔阈值。 */
export function buildTrendSeries(series: MonitoringTrendSeries[], gapMs = 30_000): BuiltTrendSeries[] {
  return series.map((line) => {
    const points = line.points
      .map((point, index) => ({ point, index, time: Date.parse(point.time) }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((a, b) => a.time - b.time || a.index - b.index);
    const data: Array<[number, number | null]> = [];
    let previous: (typeof points)[number] | undefined;

    for (const current of points) {
      const previousPeriodMs = previous ? validPeriodMs(previous.point.periodSeconds) : undefined;
      const currentPeriodMs = validPeriodMs(current.point.periodSeconds);
      // 以之前观测声明的周期判定本次间隔；首次或旧点无周期时使用当前点声明。
      const declaredPeriodMs = previousPeriodMs ?? currentPeriodMs;
      const allowedGapMs = Math.max(gapMs, declaredPeriodMs ? declaredPeriodMs * 1.5 : gapMs);
      const hasBoundary = previous != null && (
        previous.point.session !== current.point.session || current.time - previous.time > allowedGapMs
      );
      if (current.point.value == null) {
        data.push([current.time, null]);
      } else {
        if (hasBoundary) data.push([current.time, null]);
        data.push([current.time, current.point.value]);
      }
      previous = current;
    }
    const isolatedPointIndices: number[] = [];
    let segmentStart = -1;
    for (let index = 0; index <= data.length; index++) {
      if (index < data.length && data[index][1] != null) {
        if (segmentStart < 0) segmentStart = index;
      } else if (segmentStart >= 0) {
        if (index - segmentStart === 1) isolatedPointIndices.push(segmentStart);
        segmentStart = -1;
      }
    }
    return { id: line.id, name: line.name, data, isolatedPointIndices };
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
  showWindowControls = true,
}: MonitoringTrendChartProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const modelRef = useRef<ChartModel | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const frozenWindowRef = useRef<TimeWindow | null>(null);
  const applyingOptionRef = useRef(false);
  const legendSelectionRef = useRef<Record<string, boolean>>({});
  const [viewingHistory, setViewingHistory] = useState(false);
  const [windowMode, setWindowMode] = useState<TrendWindowMode>('auto');

  const compatible = series.every((line) => line.unit === unit);
  const stats = trendDataStats(compatible ? series : []);
  const visibleWindowMs = resolveTrendWindowMs(windowMode, stats, retentionMs);
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
    // 保留域仍是一小时（或调用方给定TTL），实时可视窗按已有数据量自适应，避免少量点挤在整小时最右侧。
    const dataEnd = latestTimestamp(model.compatible ? model.series : []);
    const liveEnd = Math.max(Date.now(), Number.isFinite(dataEnd) ? dataEnd : Date.now());
    const currentStats = trendDataStats(model.compatible ? model.series : []);
    const currentWindowMs = resolveTrendWindowMs(windowMode, currentStats, retention);
    const liveWindow = { start: liveEnd - currentWindowMs, end: liveEnd };
    const retentionDomain = { start: liveEnd - retention, end: liveEnd };
    const window = frozenWindowRef.current ?? liveWindow;
    // slider覆盖完整保留域；用户查看历史时再扩展到冻结窗口，实时模式只改变可视窗，不丢缓存历史。
    const domain = frozenWindowRef.current
      ? { start: Math.min(retentionDomain.start, window.start), end: Math.max(retentionDomain.end, window.end) }
      : retentionDomain;
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
      series: built.map((line) => {
        const isolatedPointIndices = new Set(line.isolatedPointIndices);
        return {
          id: line.id,
          name: line.name,
          type: 'line' as const,
          data: line.data,
          connectNulls: false,
          showSymbol: true,
          symbolSize: (_value: unknown, params: { dataIndex: number }) => isolatedPointIndices.has(params.dataIndex) ? 6 : 0,
          lineStyle: { width: 2 },
          emphasis: { focus: 'series' },
        };
      }),
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

  useEffect(() => { renderRef.current(); }, [title, unit, series, retentionMs, gapMs, windowMode]);

  const hasData = compatible && stats.validCount > 0;
  const message = compatible ? emptyText : '序列单位不一致，已停止绘制以避免混用坐标轴';
  const visibleMinutes = Math.max(1, Math.round(visibleWindowMs / 60_000));
  const retentionMinutes = Math.max(1, Math.round(retentionMs / 60_000));
  const progressText = stats.validCount === 0
    ? '尚未收到有效采样'
    : stats.validCount === 1
      ? '已收到首个采样 · 等待下一点形成折线'
      : stats.validCount === 2
        ? '2 个有效采样点 · 趋势正在形成'
        : String(stats.validCount) + ' 个有效采样点';

  return <section className="monitoring-trend-card">
    <header className="monitoring-trend-card__head">
      <div className="monitoring-trend-card__title"><h2>{title}</h2><span>{progressText}</span></div>
      {(showWindowControls || viewingHistory) && <div className="monitoring-trend-card__actions">
        {showWindowControls && <div className="monitoring-trend-card__windows" aria-label="趋势时间窗口">
          {([
            ['auto', '自动'],
            ['5m', '5分'],
            ['15m', '15分'],
            ['30m', '30分'],
            ['60m', '60分'],
          ] as Array<[TrendWindowMode, string]>).map(([mode, label]) => <button
            key={mode}
            type="button"
            className={windowMode === mode ? 'is-active' : ''}
            aria-pressed={windowMode === mode}
            onClick={() => {
              frozenWindowRef.current = null;
              setViewingHistory(false);
              setWindowMode(mode);
            }}
          >{label}</button>)}
        </div>}
        {viewingHistory && <div className="monitoring-trend-card__history" role="status">
          <span>历史查看中</span>
          <button type="button" onClick={() => { frozenWindowRef.current = null; setViewingHistory(false); renderRef.current(); }}>回到实时</button>
        </div>}
      </div>}
    </header>
    <div className="monitoring-trend-card__body">
      <div ref={elementRef} className="monitoring-trend-card__chart" role="img" aria-label={`${title}趋势，纵轴单位${unit}`} />
      {!hasData && <div className="monitoring-trend-card__empty">{message}</div>}
    </div>
    <p className="monitoring-trend-card__caption">{windowMode === 'auto' ? '自动显示最近 ' + visibleMinutes + ' 分钟' : '显示最近 ' + visibleMinutes + ' 分钟'} · 云端短缓存最多 {retentionMinutes} 分钟 · 本地时间</p>
  </section>;
}
