# 光伏·空调仿真平台

> Photovoltaic‑Air‑Conditioner Sim Platform
> 面向**光储直柔空调实验平台**（光伏 + 储能 + 热泵 + 相变蓄能 + 末端空调）的 Web 端仿真与数据可视化系统。
> 当前状态：**M1 原理图 / M1.5 动画 / M2 数据读入 / M3 数据大屏 均已完成**
> 最后更新：2026‑09‑28

---

## 这是什么

一个纯前端的实验平台可视化系统，用仿真引擎驱动 SVG 动画还原原理图，并支持导入实验采集数据
做时序回放与多维分析。

**明确不做**：硬件控制、IoT 接入、用户体系、移动端适配。

---

## 快速开始

```bash
cd apps/web
pnpm install          # 或 npm install
pnpm dev              # → http://localhost:5173
pnpm typecheck
pnpm test
pnpm build && pnpm preview
```

> 若在 Codex 环境中 `pnpm` 被安全网关拦截，改用本地二进制：
> `./node_modules/.bin/vite` / `./node_modules/.bin/tsc --noEmit` / `./node_modules/.bin/vitest run`

---

## 两个页面

| 路由 | 页面 | 能力 |
|---|---|---|
| `/` | **原理图** | 13 个部件的 SVG 动画、部件拖拽、线缆绘制、21 个滑块、9 个预设场景、时序回放时间轴 |
| `/analysis` | **数据大屏** | 导入 PDF/XLSX/CSV、实时监测 / 能量统计 / 占比分析 / 诊断对比四个视图、实验批次 A/B 对比、数据质量中心 |

---

## 导入实验数据

真实采集数据**不随仓库分发**，需要在页面里上传，支持 `PDF` / `XLSX` / `XLS` / `CSV`。

- 字段口径以 IO 点表（`字段对照表.jpg`）为权威；程序按列名别名自动识别
  （`T0.PV` → 相变温度、`D1.PV` → 直流电压、`电压(V)` → 电池包电压 …）
- 多个来源按**真实时间戳**做严格同步交集（可调 ±0.5s ~ ±60s 容差），而不是按行号对齐
- 数据质量中心会列出被隔离的行及原因（列错位、通道缺失、重复时间戳…），
  原始行不会被删除

> 力控等采集工具的导出可能出现整行列左移（温度通道里出现电压级数值）。
> 平台会识别并隔离这类行 —— 实测某次上传 554 行中隔离 60 行，
> 其中 48 行是温度通道混入 220.4V，12 行是末端传感器离线。

---

## 目录结构

```
photovoltaic-air-conditioner/
├─ AGENTS.md                  面向 AI 助手的工程规约（先读这个）
├─ README.md                  本文件
├─ apps/
│  └─ web/                    React 18 + Vite 5 + TS 5 + Zustand 4 + ECharts 6
├─ base-elements/             部件 SVG 与视觉规范
├─ data/                      本地实验数据（.gitignore 忽略，不进仓库）
├─ deploy/                    部署脚本与运维说明
├─ .github/workflows/         CI / Release
└─ docker-compose.yml         旧部署方式（保留但不参与生产发布）
```

---

## 文档

| 文档 | 用途 |
|------|------|
| [AGENTS.md](./AGENTS.md) | **工程规约**：命令、架构、不变量、已知限制、踩坑清单 |
| [base-elements/README.md](./base-elements/README.md) | SVG 视觉规范 + 动画接入规范 |
| [CICD持续集成部署.md](./CICD持续集成部署.md) | GitHub Actions → GHCR → Kubernetes 发布说明 |
| [CICD持续集成概念.md](./CICD持续集成概念.md) | CI/CD 概念说明 |
| [deploy/README.md](./deploy/README.md) | Kubernetes 更新、状态检查与回滚速查 |

设计过程中的需求/规划类文档不纳入版本管理（见 `.gitignore`）。

---

## 技术栈

React 18 · Vite 5 · TypeScript 5 · Zustand 4 · ECharts 6 · SheetJS · pdf.js · Vitest

---

## 部署

生产运行在 Kubernetes。GitHub Actions 负责校验、构建并推送镜像到 GHCR，
生产更新由运维人员在服务器上执行 `kubectl set image` + `kubectl rollout status`。
详见 [deploy/README.md](./deploy/README.md)。
