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
  const optionFrameRef = useRef(0);
  const optionRef = useRef(option);
  const onDataPointClickRef = useRef(onDataPointClick);
  optionRef.current = option;
  onDataPointClickRef.current = onDataPointClick;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    // 关键：空态时图表容器是 hidden（display:none，0×0）。
    // 在 0×0 元素上 echarts.init() 会报 "Can't get DOM width or height"，
    // 并留下一个没有 canvas 的坏实例。因此改为「拿到非零尺寸才 init」，
    // 由 ResizeObserver 在元素变为可见时触发首次初始化。
    echarts.getInstanceByDom(element)?.dispose();
    chartRef.current = null;

    let animationFrame = 0;
    let clickBound = false;

    const ensureChart = (): echarts.ECharts | null => {
      const { clientWidth: width, clientHeight: height } = element;
      if (width <= 0 || height <= 0) return null;
      let chart = chartRef.current;
      if (chart && !chart.isDisposed()) return chart;
      chart = echarts.init(element, undefined, { renderer: 'canvas' });
      chartRef.current = chart;
      if (!clickBound) {
        clickBound = true;
        chart.on('click', (params) => {
          const timestamp = Array.isArray(params.value) ? Number(params.value[0]) : NaN;
          if (Number.isFinite(timestamp)) onDataPointClickRef.current?.(timestamp);
        });
      }
      return chart;
    };

    const render = () => {
      animationFrame = 0;
      const chart = ensureChart();
      if (!chart || chart.isDisposed()) return;
      const { clientWidth: width, clientHeight: height } = element;
      chart.resize({ width, height });
      chart.setOption(optionRef.current, { notMerge: true, lazyUpdate: false });
    };
    const scheduleRender = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(render);
    };

    const observer = new ResizeObserver(scheduleRender);
    observer.observe(element);
    scheduleRender();

    return () => {
      cancelAnimationFrame(animationFrame);
      cancelAnimationFrame(optionFrameRef.current);
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const element = elementRef.current;
    // chartRef 为空说明元素还是 0×0（空态 hidden），此时不 setOption；
    // 元素变为可见时 ResizeObserver 会触发首绘并使用最新的 optionRef。
    if (!chart || !element || chart.isDisposed()) return;
    // 模式切换会同时更新多张图。同步 setOption 会让 Safari 在同一任务内连续解析
    // 数千个点，导致界面长时间无响应；放到下一帧并启用懒更新，让 React 先完成
    // 按钮和状态栏提交。首次挂载仍由 useLayoutEffect 同步首绘，避免空白图。
    cancelAnimationFrame(optionFrameRef.current);
    optionFrameRef.current = requestAnimationFrame(() => {
      if (chart.isDisposed()) return;
      chart.setOption(option, { notMerge: true, lazyUpdate: true });
      if (!chart.isDisposed() && element.clientWidth > 0 && element.clientHeight > 0) {
        chart.resize({ width: element.clientWidth, height: element.clientHeight });
      }
    });
    return () => cancelAnimationFrame(optionFrameRef.current);
  }, [option]);

  const options = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  const hasData = options.some((series) => Array.isArray((series as { data?: unknown[] }).data) && (series as { data: unknown[] }).data.some((item) => item != null && (!(typeof item === 'object') || !('value' in item) || Number((item as { value: unknown }).value) !== 0)));
  // 图表容器必须常驻。此前无数据时直接 return 空态 div，带 ref 的节点被卸载，
  // 但组件本身仍挂载 → useLayoutEffect([]) 的 cleanup 不执行 → ECharts 实例仍绑在
  // 已脱离文档树的旧 div 上；数据回来时拿到的是新 div，setOption / resize 全部打到
  // 旧实例，图表永久空白且不自愈。改为 div 常驻 + hidden 切换。
  return (
    <div className="m3-chart-shell">
      <div ref={elementRef} className="m3-chart" role="img" aria-label="数据图表" hidden={!hasData} />
      {!hasData && <div className="m3-chart-empty">{emptyMessage}</div>}
    </div>
  );
}
