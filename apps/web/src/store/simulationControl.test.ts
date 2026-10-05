import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimStore } from './simulation';
import { CABLES as STANDARD_CABLES } from '../data/cables';
import { COMPONENT_ANCHORS } from '../data/anchors';

describe('手控与回放写入边界', () => {
  beforeEach(() => useSimStore.setState({
    controlMode: 'simulation',
    playbackSnapshot: null,
    injectionFieldAvailability: {},
    pv_power: 3,
    pv_on: true,
    timelinePlaying: false,
    leftPanelOpen: false,
    rightPanelOpen: false,
    fullscreen: false,
  }));

  afterEach(() => vi.unstubAllGlobals());

  it('窄屏抽屉互斥，桌面仍允许同时展开', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: true })) });
    useSimStore.getState().toggleLeftPanel();
    useSimStore.getState().toggleRightPanel();
    expect(useSimStore.getState()).toMatchObject({ leftPanelOpen: false, rightPanelOpen: true });

    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
    useSimStore.getState().toggleLeftPanel();
    expect(useSimStore.getState()).toMatchObject({ leftPanelOpen: true, rightPanelOpen: true });
  });

  it('初始画布不预置线缆，标准拓扑由用户显式载入', () => {
    expect(useSimStore.getState().cables).toEqual([]);
  });

  it('静态手控功率仍同步 PV 开关', () => {
    useSimStore.getState().setField('pv_power', 0);
    expect(useSimStore.getState()).toMatchObject({ pv_power: 0, pv_on: false });
  });

  it('回放中修改未采集数值不得联动篡改设备状态', () => {
    useSimStore.setState({ controlMode: 'replay', injectionFieldAvailability: {}, pv_on: false });
    useSimStore.getState().setField('pv_power', 2);
    expect(useSimStore.getState()).toMatchObject({ pv_power: 2, pv_on: false });
  });

  it('回放中拒绝覆盖当前帧已经提供的字段，退出后恢复手控', () => {
    useSimStore.setState({ controlMode: 'replay', injectionFieldAvailability: { pv_power: true } });
    useSimStore.getState().setField('pv_power', 5);
    expect(useSimStore.getState().pv_power).toBe(3);

    useSimStore.getState().exitReplay();
    useSimStore.getState().setField('pv_power', 0);
    expect(useSimStore.getState()).toMatchObject({
      controlMode: 'simulation', pv_power: 0, pv_on: false, injectionFieldAvailability: {},
    });
  });
});

describe('线缆删除拓扑保全', () => {
  it('删除被引用主线时把支线接点转换为浮动坐标', () => {
    useSimStore.setState({
      cardPositions: { inverter: { x: 100, y: 200, w: 160, h: 190 } },
      cables: [
        {
          id: 'main', kind: 'power', animationEnabled: true, direction: 'forward', directionMode: 'forward',
          segments: [{ fromAnchorId: 'pv-array.right', toAnchorId: 'inverter.left' }],
        },
        {
          id: 'branch', kind: 'power', animationEnabled: true, direction: 'forward', directionMode: 'forward',
          segments: [{ fromAnchorId: 'cable:main.to', toAnchorId: 'load.left' }],
        },
      ],
    });
    useSimStore.getState().removeCable('main');
    const branch = useSimStore.getState().cables.find((cable) => cable.id === 'branch');
    expect(branch?.segments[0].fromAnchorId).toBe('');
    expect(branch?.floatingFrom).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });
});

describe('标准拓扑与空白设计图', () => {
  it('恢复标准拓扑会生成唯一且全部可解析的官方线缆', () => {
    useSimStore.getState().resetCanvasLayout();
    const cables = useSimStore.getState().cables;
    const anchorIds = new Set(COMPONENT_ANCHORS.map((anchor) => anchor.id));
    expect(cables).toHaveLength(STANDARD_CABLES.length);
    expect(new Set(cables.map((cable) => cable.id)).size).toBe(cables.length);
    for (const cable of cables) {
      expect(cable.directionMode).toMatch(/^(forward|reverse)$/);
      expect(cable.segments.length).toBeGreaterThan(0);
      for (const segment of cable.segments) {
        expect(anchorIds.has(segment.fromAnchorId)).toBe(true);
        expect(anchorIds.has(segment.toAnchorId)).toBe(true);
      }
    }
  });

  it('空白图只清线缆，仍保留全部预置仪表', () => {
    useSimStore.getState().resetCanvasLayout();
    useSimStore.getState().clearCanvasLayout();
    const state = useSimStore.getState();
    expect(state.cables).toEqual([]);
    expect(state.meters).toHaveLength(6);
    expect(state.selectedCable).toBeNull();
  });
});
