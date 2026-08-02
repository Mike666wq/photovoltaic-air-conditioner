import { TopBar } from './components/TopBar';
import { CircuitCanvas } from './components/CircuitCanvas';
import { ControlPanel } from './components/ControlPanel';
import { LogPanel } from './components/LogPanel';
import { Tooltip } from './components/Tooltip';
import { ToastContainer } from './components/ToastContainer';
import { PalettePanel } from './components/PalettePanel';
import { TimelineControls } from './components/TimelineControls';
import { useSimStore } from './store/simulation';

export function App() {
  const animationOn = useSimStore((s) => s.animationOn);
  const leftPanelOpen = useSimStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useSimStore((s) => s.rightPanelOpen);
  const fullscreen = useSimStore((s) => s.fullscreen);

  const cls = [
    'app',
    !leftPanelOpen && 'left-collapsed',
    !rightPanelOpen && 'right-collapsed',
    fullscreen && 'fullscreen',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} data-anim-on={animationOn ? 'true' : 'false'}>
      <TopBar />
      <TimelineControls />
      <PalettePanel />
      <CircuitCanvas />
      <ControlPanel />
      <LogPanel />
      <Tooltip />
      <ToastContainer />
    </div>
  );
}