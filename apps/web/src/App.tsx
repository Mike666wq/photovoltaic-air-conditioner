import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { SchematicPage } from './pages/SchematicPage';

const AnalysisDashboardPage = lazy(async () => ({
  default: (await import('./pages/AnalysisDashboardPage')).AnalysisDashboardPage,
}));

export function App() {
  return (
    <Routes>
      <Route path="/" element={<SchematicPage />} />
      <Route path="/analysis" element={<Suspense fallback={<div className="app-loading">正在加载数据分析大屏…</div>}><AnalysisDashboardPage /></Suspense>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
