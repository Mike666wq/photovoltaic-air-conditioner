import { useEffect, useState } from 'react';
import { useSimStore } from '../store/simulation';
import { SaveManager } from './SaveManager';

export function TopBar() {
  const [time, setTime] = useState(new Date());
  const [saveManagerOpen, setSaveManagerOpen] = useState(false);
  const state = useSimStore();
  const animationOn = useSimStore((s) => s.animationOn);
  const toggleAnimation = useSimStore((s) => s.toggleAnimation);
  const toggleEditMode = useSimStore((s) => s.toggleEditMode);
  const editMode = useSimStore((s) => s.editMode);
  const showGrid = useSimStore((s) => s.showGrid);
  const toggleGrid = useSimStore((s) => s.toggleGrid);
  const resetLayout = useSimStore((s) => s.resetLayout);
  const leftPanelOpen = useSimStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useSimStore((s) => s.rightPanelOpen);
  const fullscreen = useSimStore((s) => s.fullscreen);
  const toggleLeftPanel = useSimStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = useSimStore((s) => s.toggleRightPanel);
  const toggleFullscreen = useSimStore((s) => s.toggleFullscreen);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const ss = String(time.getSeconds()).padStart(2, '0');

  // 编辑模式默认布局（12 部件 2×6：行1 PV/CB/Grid/GS/IV/Bat；行2 HP/Tank/Pump/PCM/AT/PM）
  const defaultPositions: Record<string, { x: number; y: number }> = {
    'pv-array':     { x: 100, y: 200 },
    'combiner-box': { x: 340, y: 200 },
    'grid':         { x: 580, y: 200 },
    'grid-switch':  { x: 820, y: 200 },
    'inverter':     { x: 1060, y: 200 },
    'battery':      { x: 1300, y: 200 },
    'heat-pump':    { x: 100, y: 750 },
    'tank':         { x: 340, y: 750 },
    'pump':         { x: 580, y: 750 },
    'pcm':          { x: 820, y: 750 },
    'air-terminal': { x: 1060, y: 750 },
    'power-meter':  { x: 1300, y: 750 },
  };

  return (
    <div className="topbar">
      <div className="topbar-title">
        <svg viewBox="0 0 24 24"><path d="M13 2L3 14h7l-1 8l10-12h-7l1-8z" /></svg>
        <span>光伏·空调仿真平台 — 原理图页面 (M1)</span>
      </div>

      <div className="topbar-actions">
        <button
          className={`topbar-btn ${animationOn ? 'primary' : ''}`}
          onClick={toggleAnimation}
          title={animationOn ? '暂停所有动画与粒子' : '启动所有动画与粒子'}
        >
          {animationOn ? '⏸ 暂停动画' : '▶ 启动动画'}
        </button>
        <button
          className={`topbar-btn ${editMode ? 'primary' : ''}`}
          onClick={toggleEditMode}
          title={editMode ? '退出编辑模式' : '进入编辑模式（可拖拽部件）'}
        >
          {editMode ? '🔓 编辑中' : '🔒 锁定'}
        </button>
        <button
          className={`topbar-btn ${showGrid ? 'primary' : ''}`}
          onClick={toggleGrid}
          title={showGrid ? '隐藏网格' : '显示网格'}
        >
          {showGrid ? '▦ 网格' : '▢ 网格'}
        </button>
        <span className="topbar-divider" />
        <button
          className={`topbar-btn ${leftPanelOpen ? 'primary' : ''}`}
          onClick={toggleLeftPanel}
          title={leftPanelOpen ? '折叠调色板' : '展开调色板'}
        >
          {leftPanelOpen ? '◨ 调色板' : '◧ 调色板'}
        </button>
        <button
          className={`topbar-btn ${rightPanelOpen ? 'primary' : ''}`}
          onClick={toggleRightPanel}
          title={rightPanelOpen ? '折叠控制面板' : '展开控制面板'}
        >
          {rightPanelOpen ? '◨ 控制台' : '◧ 控制台'}
        </button>
        <button
          className={`topbar-btn ${fullscreen ? 'primary' : ''}`}
          onClick={toggleFullscreen}
          title={fullscreen ? '退出全屏模式' : '进入全屏模式（隐藏两侧栏）'}
        >
          {fullscreen ? '⛶ 全屏中' : '⛶ 全屏'}
        </button>
        <span className="topbar-divider" />
        <button
          className="topbar-btn"
          onClick={() => setSaveManagerOpen(true)}
          title="管理保存的状态文件"
        >
          💾 状态
        </button>
        <button
          className="topbar-btn"
          onClick={() => resetLayout(defaultPositions)}
          title="重置为默认 2×7 布局"
        >
          ↺ 重置
        </button>
      </div>

      <div className="topbar-stats">
        <span>PV: <span className="stat-value">{state.pv_power.toFixed(2)} kW</span></span>
        <span>SOC: <span className="stat-value">{Math.round(state.bat_soc)}%</span></span>
        <span>Tank: <span className="stat-value">{Math.round(state.tank_temp)}℃</span></span>
        <span>时钟: <span className="stat-value">{hh}:{mm}:{ss}</span></span>
      </div>
      <SaveManager open={saveManagerOpen} onClose={() => setSaveManagerOpen(false)} />
    </div>
  );
}