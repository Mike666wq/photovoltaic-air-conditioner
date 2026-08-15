import { useEffect, useLayoutEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

interface Props {
  option: EChartsOption;
  onDataPointClick?: (timestamp: number) => void;
  emptyMessage?: string;
}

/** 统一处理 ECharts 的初始化、ResizeObserver 和路由卸载 dispose。 */
export function EChart({ option, onDataPointClick, emptyMessage = '当前数据源缺少该图所需字段，或所选时段没有有效样本。' }: Props) {
  const elementRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);
  const onDataPointClickRef = useRef(onDataPointClick);
  optionRef.current = option;
  onDataPointClickRef.current = onDataPointClick;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    // ECharts 在 display/grid 切换期间若以 0×0 尺寸初始化，会留下一个实例却没有
    // canvas。先清理可能由 StrictMode 或路由切换遗留的实例，并把首次绘制延后到
    // 浏览器完成布局后。
    echarts.getInstanceByDom(element)?.dispose();
    const chart = echarts.init(element, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    let animationFrame = 0;
    const render = () => {
      animationFrame = 0;
      if (chart.isDisposed()) return;
      const { clientWidth: width, clientHeight: height } = element;
      if (width <= 0 || height <= 0) return;
      chart.resize({ width, height });
      chart.setOption(optionRef.current, { notMerge: true, lazyUpdate: false });
    };
    const scheduleRender = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(render);
    };

    const observer = new ResizeObserver(scheduleRender);
    observer.observe(element);
    chart.on('click', (params) => {
      const timestamp = Array.isArray(params.value) ? Number(params.value[0]) : NaN;
      if (Number.isFinite(timestamp)) onDataPointClickRef.current?.(timestamp);
    });
    scheduleRender();

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const element = elementRef.current;
    if (!chart || !element || chart.isDisposed()) return;
    // option 更新可能发生在 CSS grid 重排同一轮渲染中；先以最新 option 绘制，
    // 随后的 ResizeObserver 会用正确尺寸再绘制一次。
    chart.setOption(option, { notMerge: true, lazyUpdate: false });
    requestAnimationFrame(() => {
      if (!chart.isDisposed() && element.clientWidth > 0 && element.clientHeight > 0) {
        chart.resize({ width: element.clientWidth, height: element.clientHeight });
      }
    });
  }, [option]);

  const options = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  const hasData = options.some((series) => Array.isArray((series as { data?: unknown[] }).data) && (series as { data: unknown[] }).data.some((item) => item != null && (!(typeof item === 'object') || !('value' in item) || Number((item as { value: unknown }).value) !== 0)));
  if (!hasData) return <div className="m3-chart-empty">{emptyMessage}</div>;
  return <div ref={elementRef} className="m3-chart" role="img" aria-label="数据图表" />;
}
