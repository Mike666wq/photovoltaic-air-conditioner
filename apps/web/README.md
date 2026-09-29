# apps/web — 仿真平台前端

React 18 + Vite 5 + TypeScript 5 + Zustand 4 + ECharts 6。

## 命令

```bash
pnpm install
pnpm dev            # dev server → http://localhost:5173
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run（29 个测试文件）
pnpm build          # tsc -b && vite build && node scripts/copy-svgs.mjs
pnpm preview
```

> Codex 环境下 `pnpm` 可能被安全网关拦截，改用 `./node_modules/.bin/<tool>`。

## 目录

```
src/
├─ main.tsx              入口（Safari ReadableStream polyfill + ErrorBoundary）
├─ App.tsx               路由（/ 与 /analysis）+ 全局 ToastContainer
├─ pages/
│  ├─ SchematicPage.tsx      原理图页布局
│  └─ AnalysisDashboardPage.tsx  数据大屏（最大页面，导入/视图/批次/诊断）
├─ components/           TopBar、TimelineControls、CircuitCanvas（1998 行，最大文件）、
│                        ControlPanel、ComponentDetail、dashboard/* 等
├─ hooks/                粒子/太阳/火花动画、弹窗无障碍、时序回放循环
├─ engine/               几何、布线路由、粒子运动、功率流、视觉对齐、PCM 派生
├─ injector/injector.ts  SimulationState → SVG 视觉的唯一通道
├─ services/             数据管线：解析 → 质量检查 → 同步会话 → 指标计算 → 持久化
├─ store/                simulation（主状态）、analysis（数据源/批次/口径）、toast
├─ workers/              XLSX 解析 Worker
└─ data/                 静态定义：部件、线缆、仪表、预设、图表字段、source profile
```

`base-elements/` 下的部件 SVG 通过 `vite-svg-plugin`（dev）与 `copy-svgs.mjs`（build）提供。

## 注意

- **测试不得依赖 `data/` 目录**（该目录被 gitignore 且不进仓库，CI 上不存在）。
  需要数据时用 `xlsx` 库现场生成夹具，范例见 `src/services/actualDataAcceptance.test.ts`。
- 开发中如遇 SVG 更新不生效，用 `Cmd+Shift+R` 硬刷新绕过浏览器缓存。
- 详细工程规约见根目录 [`AGENTS.md`](../AGENTS.md)。
