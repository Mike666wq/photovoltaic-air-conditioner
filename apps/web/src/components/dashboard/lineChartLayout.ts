import type { EChartsOption } from 'echarts';

export interface LineChartAxisSeries {
  unit: string;
  axis?: 0 | 1;
}

function axisNameForUnit(unit: string): string {
  switch (unit) {
    case 'V': return '电压（V）';
    case 'A': return '电流（A）';
    case '℃': return '温度（℃）';
    case '%': return 'SOC（%）';
    default: return `单位（${unit}）`;
  }
}

/** 实时折线图共享的布局：长图例可滚动，密集时间标签自动避让，双轴单位有明确名称。 */
export function buildLineChartLayout(series: LineChartAxisSeries[]): EChartsOption {
  const axisCount = series.some((item) => item.axis === 1) ? 2 : 1;
  const axes = Array.from({ length: axisCount }, (_, index) => {
    const units = [...new Set(series
      .filter((item) => (item.axis ?? 0) === index)
      .map((item) => item.unit))];
    const axisName = units.map(axisNameForUnit).join(' / ');
    return {
      type: 'value' as const,
      name: axisName,
      nameLocation: 'middle' as const,
      nameGap: 44,
      nameTextStyle: { color: '#8da9bd', fontSize: 11 },
      position: index === 0 ? 'left' as const : 'right' as const,
      axisLabel: { color: '#8da9bd' },
      splitLine: index === 0
        ? { lineStyle: { color: 'rgba(148,203,232,.12)' } }
        : { show: false },
    };
  });

  return {
    legend: {
      type: 'scroll',
      orient: 'horizontal',
      top: 2,
      left: 8,
      right: 8,
      height: 26,
      textStyle: { color: '#d7efff', fontSize: 11 },
      itemWidth: 18,
      itemHeight: 9,
      itemGap: 8,
      pageIconColor: '#7dd3fc',
      pageTextStyle: { color: '#8da9bd' },
    },
    grid: {
      top: 42,
      left: 62,
      right: axisCount > 1 ? 62 : 20,
      bottom: 54,
      containLabel: true,
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#31516a' } },
      axisLabel: { color: '#8da9bd', hideOverlap: true, margin: 10 },
    },
    yAxis: axisCount > 1 ? axes : axes[0],
    dataZoom: [
      { type: 'inside' },
      {
        type: 'slider',
        height: 14,
        bottom: 7,
        borderColor: 'transparent',
        fillerColor: 'rgba(34,211,238,.16)',
        textStyle: { color: '#8da9bd' },
        showDetail: false,
        handleSize: 12,
      },
    ],
  };
}
