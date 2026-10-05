import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSimStore } from '../store/simulation';
import { SaveManager } from './SaveManager';
import { Link, useNavigate } from 'react-router-dom';
import { DeploymentVersion } from './DeploymentVersion';

export function TopBar() {
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());
  const [saveManagerOpen, setSaveManagerOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDetailsElement>(null);
  const drawerWasOpenRef = useRef(false);
  const state = useSimStore();
  const animationOn = useSimStore((s) => s.animationOn);
  const toggleAnimation = useSimStore((s) => s.toggleAnimation);
  const toggleEditMode = useSimStore((s) => s.toggleEditMode);
  const editMode = useSimStore((s) => s.editMode);
  const showGrid = useSimStore((s) => s.showGrid);
  const toggleGrid = useSimStore((s) => s.toggleGrid);
  const toggleSnapToGrid = useSimStore((s) => s.toggleSnapToGrid);
  const toggleSmartGuides = useSimStore((s) => s.toggleSmartGuides);
  const setGridSize = useSimStore((s) => s.setGridSize);
  const resetCanvasLayout = useSimStore((s) => s.resetCanvasLayout);
  const clearCanvasLayout = useSimStore((s) => s.clearCanvasLayout);
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

  useLayoutEffect(() => {
    const compact = window.matchMedia('(max-width: 900px), (max-height: 500px) and (max-width: 1000px)');
    const syncMenuMode = () => {
      if (toolsMenuRef.current) toolsMenuRef.current.open = !compact.matches;
    };
    syncMenuMode();
    compact.addEventListener?.('change', syncMenuMode);
    return () => compact.removeEventListener?.('change', syncMenuMode);
  }, []);

  useEffect(() => {
    const panelsOpen = leftPanelOpen || rightPanelOpen;
    const narrow = window.matchMedia('(max-width: 900px), (max-height: 500px) and (max-width: 1000px)');
    if (!panelsOpen) {
      if (drawerWasOpenRef.current && narrow.matches) requestAnimationFrame(() => toolsMenuRef.current?.querySelector('summary')?.focus({ preventScroll: true }));
      drawerWasOpenRef.current = false;
      return;
    }
    drawerWasOpenRef.current = true;
    const closeSelector = leftPanelOpen ? '.palette-collapse-btn' : '.control-collapse-btn';
    const focusDrawerClose = () => {
      if (narrow.matches) document.querySelector<HTMLButtonElement>(closeSelector)?.focus({ preventScroll: true });
    };
    const frame = requestAnimationFrame(focusDrawerClose);
    const onEscape = (event: KeyboardEvent) => {
      if (!narrow.matches || event.key !== 'Escape') return;
      // 让已打开的顶层弹窗（由 useModalA11y 管理）优先消费 Esc。
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
      event.preventDefault();
      useSimStore.setState({ leftPanelOpen: false, rightPanelOpen: false });
      toolsMenuRef.current && (toolsMenuRef.current.open = false);
    };
    const onMediaChange = () => {
      const current = useSimStore.getState();
      if (narrow.matches && current.leftPanelOpen && current.rightPanelOpen) useSimStore.setState({ leftPanelOpen: false });
      else focusDrawerClose();
    };
    window.addEventListener('keydown', onEscape);
    narrow.addEventListener?.('change', onMediaChange);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onEscape); narrow.removeEventListener?.('change', onMediaChange); };
  }, [leftPanelOpen, rightPanelOpen]);

  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const ss = String(time.getSeconds()).padStart(2, '0');

  const fitCanvas = () => window.dispatchEvent(new Event('canvas-fit'));
  const hasDataSession = state.controlMode === 'replay' && state.playbackSnapshot != null;
  const showInjected = (field: 'pv_power' | 'bat_soc' | 'tank_temp') =>
    !hasDataSession || state.injectionFieldAvailability[field] === true;

  return (
    <div className="topbar">
      <div className="topbar-title">
        <svg viewBox="0 0 24 24"><path d="M13 2L3 14h7l-1 8l10-12h-7l1-8z" /></svg>
        <span>光伏·空调仿真平台 — 原理图</span>
      </div>

      <details ref={toolsMenuRef} className="topbar-tools">
        <summary>☰ 工具</summary>
      <div className="topbar-actions" onClick={(event) => {
        if (!window.matchMedia('(max-width: 900px), (max-height: 500px) and (max-width: 1000px)').matches) return;
        const target = event.target as HTMLElement;
        if (!target.closest('button, a') || target.closest('.snap-menu > summary')) return;
        toolsMenuRef.current?.querySelector('summary')?.focus({ preventScroll: true });
        if (toolsMenuRef.current) toolsMenuRef.current.open = false;
      }}>
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
        <details className="snap-menu">
          <summary className={`topbar-btn ${state.snapToGrid || state.smartGuides ? 'primary' : ''}`} title="设置智能吸附">
            🧲 吸附
          </summary>
          <div className="snap-menu-popover" onClick={(event) => event.stopPropagation()}>
            <label><input type="checkbox" checked={state.smartGuides} onChange={toggleSmartGuides} /> 对象边缘与中心</label>
            <label><input type="checkbox" checked={state.snapToGrid} onChange={toggleSnapToGrid} /> 吸附到网格</label>
            <label>
              网格尺寸
              <select value={state.gridSize} onChange={(event) => setGridSize(Number(event.target.value))}>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={40}>40</option>
              </select>
            </label>
            <small>拖动时按 Alt/Option 可临时关闭吸附</small>
          </div>
        </details>
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
        <Link className="topbar-btn" to="/analysis" title="进入数据分析大屏">
          📊 数据分析
        </Link>
        <Link className="topbar-btn" to="/monitoring" title="进入统一本地监控">本地监控</Link>
        <button
          className="topbar-btn"
          onClick={() => setSaveManagerOpen(true)}
          title="管理保存的状态文件"
        >
          💾 状态
        </button>
        <button
          className="topbar-btn"
          onClick={fitCanvas}
          title="居中并缩放到全部部件、仪表与线缆"
        >
          ⌖ 回正
        </button>
        <button
          className="topbar-btn"
          onClick={() => window.dispatchEvent(new Event('canvas-align-all'))}
          title="小幅整理安全直连的器件、分开重叠卡片；不改线缆端口，浮动接点支路保持原位"
        >
          ◎ 一键整理
        </button>
        <button
          className="topbar-btn"
          onClick={() => { resetCanvasLayout(); window.requestAnimationFrame(fitCanvas); }}
          title="恢复官方标准拓扑、默认部件位置与预置仪表"
        >
          ↺ 标准拓扑
        </button>
        <button
          className="topbar-btn"
          onClick={() => {
            if (!window.confirm('新建空白设计图会清除当前全部线缆与布局调整，是否继续？')) return;
            clearCanvasLayout();
            window.requestAnimationFrame(fitCanvas);
          }}
          title="清空全部线缆，保留标准部件与预置仪表"
        >
          □ 空白图
        </button>
      </div>
      </details>

      <div className="topbar-stats">
        <span>PV: <span className="stat-value">{showInjected('pv_power') ? `${state.pv_power.toFixed(2)} kW` : '—'}</span></span>
        <span>SOC: <span className="stat-value">{showInjected('bat_soc') ? `${Math.round(state.bat_soc)}%` : '—'}</span></span>
        <span>Tank: <span className="stat-value">{showInjected('tank_temp') ? `${Math.round(state.tank_temp)}℃` : '—'}</span></span>
        <span>时钟: <span className="stat-value">{hh}:{mm}:{ss}</span></span>
      </div>
      <DeploymentVersion />
      <SaveManager open={saveManagerOpen} onClose={() => setSaveManagerOpen(false)} />
    </div>
  );
}
