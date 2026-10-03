import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { bmsTime } from '../../services/bmsRealtimeTypes';
import type { TrendPoint } from '../../services/bmsRealtimeTypes';

const clock = (value: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(value);
export function BmsTrendChart({ title, unit, color, points }: { title: string; unit: string; color: string; points: TrendPoint[] }) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const zoom = useRef<{ startValue: number; endValue: number } | null>(null);
  const render = useRef<() => void>(() => {});
  render.current = () => {
    const el = element.current; if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return;
    if (!chart.current) {
      chart.current = echarts.init(el);
      chart.current.on('datazoom', () => {
        const current = (chart.current?.getOption().dataZoom as { start?: number; end?: number; startValue: number; endValue: number }[])?.[0];
        if (current) zoom.current = current.start === 0 && current.end === 100 ? null : { startValue: current.startValue, endValue: current.endValue };
      });
    }
    chart.current.resize();
    chart.current.setOption({
      animation: false,
      grid: { left: 58, right: 24, top: 28, bottom: 78 },
      tooltip: { trigger: 'axis', formatter: (params: unknown) => { const p = (Array.isArray(params) ? params[0] : params) as { value?: number[] }; const v = p?.value; return v ? `${bmsTime(new Date(v[0]).toISOString())}<br/>${title}：${v[1].toFixed(2)} ${unit}` : ''; }, axisPointer: { type: 'line' } },
      xAxis: { type: 'time', splitNumber: 3, axisLabel: { color: '#64748b', hideOverlap: true, formatter: clock }, axisLine: { lineStyle: { color: '#dbe3ee' } } },
      yAxis: { type: 'value', name: unit, scale: true, ...(unit === '%' ? { min: Math.min(0, ...points.map((p) => p.value)), max: Math.max(100, ...points.map((p) => p.value)) } : {}), nameTextStyle: { color: '#64748b' }, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { color: '#edf1f6' } } },
      dataZoom: [{ type: 'inside', ...(zoom.current ?? { start: 0, end: 100 }) }, { type: 'slider', height: 18, bottom: 18, showDetail: false, ...(zoom.current ?? { start: 0, end: 100 }) }],
      series: [{ name: title, type: 'line', showSymbol: points.length === 1, symbolSize: 6, lineStyle: { width: 2 }, itemStyle: { color }, areaStyle: { color, opacity: 0.06 }, data: [...points].sort((a, b) => Date.parse(a.capturedUtc) - Date.parse(b.capturedUtc)).map((p) => [Date.parse(p.capturedUtc), p.value]) }],
    });
  };
  useEffect(() => {
    const observer = new ResizeObserver(() => render.current());
    if (element.current) observer.observe(element.current);
    render.current();
    return () => { observer.disconnect(); chart.current?.dispose(); chart.current = null; };
  }, []);
  useEffect(() => { render.current(); }, [points, title, unit, color]);
  return <section className="bms-chart-card">
    <div className="bms-card-head"><h2>{title}</h2><button onClick={() => { zoom.current = null; render.current(); }}>返回最新</button></div>
    <div className="bms-chart-body"><div ref={element} className="bms-chart" role="img" aria-label={`${title}短趋势，单位${unit}`} />{points.length === 0 && <div className="bms-chart-empty">等待采样后显示短趋势</div>}</div>
    <p className="bms-caption">最近10分钟 · 最多600点 · 时间为中国标准时间</p>
  </section>;
}
