import { describe, expect, it } from 'vitest';
import { buildLineChartLayout } from './lineChartLayout';

describe('实时折线图布局', () => {
  it('长图例可横向滚动，密集时间刻度会避让且数据缩放留有独立空间', () => {
    const layout = buildLineChartLayout([
      { unit: '℃' }, { unit: '℃' }, { unit: '℃' }, { unit: '℃' },
    ]);

    expect(layout.legend).toMatchObject({ type: 'scroll', orient: 'horizontal' });
    expect(layout.xAxis).toMatchObject({ type: 'time', axisLabel: { hideOverlap: true } });
    expect(layout.grid).toMatchObject({ containLabel: true });
    expect(layout.dataZoom).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'inside' }),
      expect.objectContaining({ type: 'slider', showDetail: false }),
    ]));
  });

  it('双轴分别显示电压和电流单位，并为两侧轴标签留边距', () => {
    const layout = buildLineChartLayout([
      { unit: 'V' }, { unit: 'A', axis: 1 },
    ]);

    expect(layout.yAxis).toEqual([
      expect.objectContaining({ name: '电压（V）', position: 'left', nameLocation: 'middle' }),
      expect.objectContaining({ name: '电流（A）', position: 'right', nameLocation: 'middle' }),
    ]);
    expect(layout.grid).toMatchObject({ containLabel: true });
  });

  it('同一轴上的多个单位会完整标出，不会被第一个系列的单位掩盖', () => {
    const layout = buildLineChartLayout([
      { unit: '%' }, { unit: 'V', axis: 1 }, { unit: 'A', axis: 1 },
    ]);

    expect(layout.yAxis).toEqual([
      expect.objectContaining({ name: 'SOC（%）' }),
      expect.objectContaining({ name: '电压（V） / 电流（A）' }),
    ]);
  });

  it('单轴曲线只生成实际使用的轴，并显示该轴单位', () => {
    const layout = buildLineChartLayout([{ unit: '℃' }]);

    expect(layout.yAxis).toMatchObject({ name: '温度（℃）' });
    expect(Array.isArray(layout.yAxis)).toBe(false);
  });
});
