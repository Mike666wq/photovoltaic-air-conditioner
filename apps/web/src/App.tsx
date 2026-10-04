import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ToastContainer } from './components/ToastContainer';
import { SchematicPage } from './pages/SchematicPage';

const loadAnalysisDashboard = () => import('./pages/AnalysisDashboardPage');
const AnalysisDashboardPage = lazy(async () => ({
  default: (await loadAnalysisDashboard()).AnalysisDashboardPage,
}));
const BmsRealtimePage = lazy(async () => ({ default: (await import('./pages/BmsRealtimePage')).BmsRealtimePage }));
const ExperimentRealtimePage = lazy(() => import('./pages/ExperimentRealtimePage').then(m => ({ default: m.ExperimentRealtimePage })));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage').then(m => ({ default: m.MonitoringPage })));
const BmsManagePage = lazy(async () => ({ default: (await import('./pages/BmsManagePage')).BmsManagePage }));

export function App() {
  useEffect(() => {
    // 原理图首屏稳定后在空闲阶段预取大屏与 ECharts 代码，避免用户第一次点击
    // “数据分析”时才下载、解析整块依赖。超时兜底保证浏览器不支持 idle API 时也可预热。
    const preload = () => { void loadAnalysisDashboard(); };
    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(preload, { timeout: 2_000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = globalThis.setTimeout(preload, 800);
    return () => globalThis.clearTimeout(timeoutId);
  }, []);

  return (
    <>
      <Routes>
        <Route path="/" element={<SchematicPage />} />
        <Route path="/analysis" element={<Suspense fallback={<div className="app-loading">正在加载数据分析大屏…</div>}><AnalysisDashboardPage /></Suspense>} />
        <Route path="/bms/realtime" element={<Suspense fallback={<div className="app-loading">正在加载BMS实时监测…</div>}><BmsRealtimePage /></Suspense>} />
        <Route path="/monitoring" element={<Suspense fallback={<div className="app-loading">正在加载云端监控…</div>}><MonitoringPage /></Suspense>} />
        <Route path="/experiment/realtime" element={<Suspense fallback={<div className="app-loading">正在加载系统实验监控…</div>}><ExperimentRealtimePage /></Suspense>} />
        <Route path="/monitoring/manage" element={<Suspense fallback={<div className="app-loading">正在加载设备管理…</div>}><BmsManagePage /></Suspense>} />
        <Route path="/bms/manage" element={<Suspense fallback={<div className="app-loading">正在加载设备注册与接入…</div>}><BmsManagePage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* ToastContainer 提到路由外层：此前只挂在原理图页，大屏调用 useToastStore 会静默无效 */}
      <ToastContainer />
    </>
  );
}
