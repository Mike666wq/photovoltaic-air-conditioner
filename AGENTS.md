# AGENTS.md — 光伏·空调仿真平台

> 面向 AI 编码助手的工程规约。**与代码冲突时以代码为准，并顺手修正本文档。**
> 最后核对：2026-10-03（对应 `apps/web` 现状）

## 0. 三条最容易踩的坑（先看这里）

1. **`pnpm` 在本机被 Codex 安全网关拦截**（`pnpm@9.0.0` 签名校验失败 + 无网络）。
   一律用本地二进制：`./node_modules/.bin/tsc --noEmit`、`./node_modules/.bin/vitest run`、`./node_modules/.bin/vite`。
2. **真实实验数据是用户运行时上传的**，`data/` 已被 `.gitignore` 忽略、**不进仓库**，
   且每次上传的列名/列数/采样率都不同。**任何测试都不得依赖 `data/` 里的文件**——
   否则 CI 必然失败。测试需要数据时用 `xlsx` 库现场生成同构夹具（范例见
   `src/services/actualDataAcceptance.test.ts`）。
3. **文档高度易腐**。本文件曾在半年里记录了「15 个滑块 / PDF 数据源 / 1800×1100 viewBox 画布」，
   全部与现实不符。改动架构时**必须同步改这里**。

## 1. 现状快照

| 项 | 实际值 |
|---|---|
| 阶段 | M1 原理图 / M1.5 动画 / M2 数据读入 / **M3 数据大屏均已完成** |
| 路由 | `/`（原理图）、`/analysis`（数据大屏，懒加载）、`/bms/realtime`（独立BMS实时页，懒加载） |
| 部件 | **13** 个（`data/components.ts`） |
| 预设 | **9** 个 + 🎲 随机扰动（`data/presets.ts`） |
| 控制面板滑块 | **21** 个 |
| 预置仪表 | **6** 个（2 功率检测器 + 4 温度检测器） |
| 默认回放 | 一个实验批次内的多数据源共享严格同步时间轴；大屏单源模式同步切换回放来源 |
| 验收夹具 | 测试现场生成同构数据，不读取被忽略的 `data/` |
| 源码头 | 124 个 action（`store/simulation.ts`） |
| 代码量 | TS/TSX源码 ~14.9k 行 / Vitest测试 ~2.7k 行、**31 个文件**；另有独立Node实时API测试 |
| 测试 | `vitest run` 与 `node --test scripts/realtime/*.test.mjs` 均通过才算完成 |
| BMS实时页 | v1只读接口；设备Bearer与独立观看Cookie；45秒观看租约；每Pack最多600点/10分钟短趋势；不接入仿真/分析store |
| 大屏布局 | 桌面 12 列；窄屏 6 列并按断点调整指标卡和图表跨度，不生成隐式列；舞台内容超高时纵向滚动；实时折线图共享可滚动图例和防重叠时间轴 |

## 2. 常用命令

```bash
cd apps/web
./node_modules/.bin/tsc --noEmit        # 类型检查
./node_modules/.bin/vitest run          # 前端/原有业务测试
node --test scripts/realtime/*.test.mjs # 实时API集成测试（临时loopback端口）
./node_modules/.bin/vitest run src/xxx  # 单文件
./node_modules/.bin/vite                # dev server → http://127.0.0.1:5173
./node_modules/.bin/vite build          # 生产构建（build 脚本还会跑 tsc -b + copy-svgs）
```

### 浏览器验证

使用当前提供的 `mcp__cua_repl` 浏览器自动化：先查看可用浏览器/标签，再打开本地地址
`http://127.0.0.1:5173/analysis`。通过页面文件选择器上传现场生成的 CSV/XLSX/PDF 夹具，
从可见 DOM 检查导入状态、帧数和图表；测试不得依赖被忽略的 `data/` 文件。

注意事项：
- 跨页面验证使用应用内 SPA 导航，不要整页重载：zustand 是内存态，重载会清空已导入数据；
- 不要通过动态 `import('/src/...')` 读取 store，模块可能是另一个实例；以页面 DOM 为准；
- 无头环境下 `requestAnimationFrame` 会被节流，需要定时器的地方不能用它。

## 3. 架构

```
apps/web/src/
├─ pages/          SchematicPage（原理图）、AnalysisDashboardPage（大屏）、BmsRealtimePage（独立实时页）
├─ components/     TopBar / TimelineControls / CircuitCanvas(1998行) / ControlPanel /
│                  PalettePanel / ComponentDetail / ImportDataDialog / SaveManager /
│                  LogPanel / Tooltip / ToastContainer / TsPointer / GridPattern /
│                  CableControlDetail / CableControlItem
│                  ├─ dashboard/  ChartPanel / EChart / MetricCard
│                  └─ bmsRealtime/ BmsTrendChart（独立实例/单位/缩放）
├─ hooks/          useParticleAnimation / usePvSunAnimation / useTransientSpark /
│                  useModalA11y / useTimelinePlayback
├─ engine/         canvasGeometry / orthogonalRouter / particleMotion / powerFlow /
│                  alignment / schematicControl / pcm
├─ injector/       injector.ts（SimulationState → SVG 视觉的唯一通道）
├─ services/       数据管线：injectionParser / dataSourcePipeline / playbackSession /
│                  playbackController / schematicFrame / meterInject / analysisSeries /
│                  operationalDiagnostics / sessionCoordinator / sourceCache / experiment* /
│                  stateSerializer / dataset / batteryConvention / preparedImport / bmsRealtime*
├─ store/          simulation（主状态）、analysis（数据源/批次/口径）、toast、bmsRealtime（隔离实时态）
├─ workers/        dataImportWorker（XLSX 解析，主线程不阻塞）
├─ data/           components / cables / meters / presets / chartFields / sourceProfile /
│                  pdfFieldMap / saveSchema / palettes
└─ pages/…         styles.css、analysis-dashboard.css
```

### 画布：不是 SVG viewBox，是 HTML 卡片网格

**这一条推翻了旧文档**。画布是绝对定位的 HTML 卡片网格：

- `engine/canvasGeometry.ts`：`COMPONENT_WORLD_SIZE = 180×210`，`CARD_PORTS` 定义四边中点接线口
- 缩放由 `.world-layer` 的 `transform: translate(x,y) scale(zoom)` 统一处理
- `positions[id]` / `floatingFrom` / `presetVb` **都是世界坐标 px**，不是屏幕 CSS 像素
- `data/anchors.ts` 是**死代码**（唯一引用是它自己的测试），别照着它理解接线

### 数据注入通道

`CircuitCanvas` 的 `ComponentSlot` 依次：`fetch SVG → DOMParser → buildInjectData(state) →
injector → cloneNode → 渲染`。`injector.ts` 是状态到视觉的**唯一**通道，通过
`[data-animation-id]` 与 `[data-field]` 匹配。

## 4. 数据管线（用户运行时上传）

```
File → preparedImport（xlsx 走 Worker / pdf+csv 走主线程）
     → parseFile → parseXLSX|parsePDF|parseCSV
     → prepareDataSource（sourceProfile 识别 + 质量检查）
     → commitPreparedExperiment（协调器：一次提交 analysis / sim / batch 三处）
     → buildPlaybackSession（严格同步交集）→ applyTimelineFrame
     → schematicFrame / meterInject → 仪表与部件
```

### 质量闸门（`dataSourcePipeline.ts`）

- `temperature_voltage_misalignment` 与 `value_out_of_range` 都**整行作废**。
  原因是列错位时同行其它列位置全部不可信。**只有确实恢复到数据源时才清空旧分析库**。
- 通道级隔离尚未开启（需先补 `untrustedFields` 地基，见
  `playbackSession.canonicalData` / `analysisSeries.buildAnalysisPoints`——
  这两处**绕过质量层重新 parseFloat 原始单元格**，放宽前必须先让它们消费隔离标记）。

## 5. 必须维持的不变量

这些都有测试锁定，改动时别破坏：

| 不变量 | 位置 | 说明 |
|---|---|---|
| `pv_on === derivePvOn(pv_power)` | `store/simulation.ts` | **`pv_power` 是权威，`pv_on` 是派生量**。UI 只有功率滑块，没有 pv_on 开关；`schematicFrame` 也由功率派生。所有写 `pv_power` 的路径必须同步派生 |
| PCM 温度恒显实测值 | `engine/pcm.ts` | 曾把 1~49℃ 整段当"相变平台"恒显 `25.0℃`，已修。**不要用常数冒充测量读数** |
| BMS实时隔离与口径 | `bmsRealtime*` / `scripts/realtime/` | v1保持centiV/centiA/centiAh与原始温度；只标电流正负；不解码未知告警，不读写simulation/analysis/injector；未观看不上传，心跳不代表串口采集；租约TTL用服务端单调时钟 |
| BMS缓存/部署 | `scripts/realtime/state.mjs` / `routes.mjs` | 每Pack最多600点且10分钟；去重按会话和序号、各通道水位；SSE授权和缓冲有界；当前仅单Node进程，K8s单副本Recreate；多实例须共享状态；凭据仅Secret/外部文件 |
| 电池符号唯一入口 | `services/batteryConvention.ts` | 用户口径（analysis store）→ 原理图内部口径（正=放电），三处调用统一走它，`unknown` 返回 null 不猜方向 |
| 导入三态反馈 | `AnalysisDashboardPage` | 全成功✓ / 部分⚠ / 全失败✕，**不要无条件加绿勾** |
| 弹窗无障碍 | `hooks/useModalA11y.ts` | Esc/Tab 只由最上层弹窗处理；关闭子层恢复父层触发按钮焦点。`ComponentDetail` 是**常驻挂载内部 return null**，`open` 必须传真实状态 |
| 场景会话恢复 | `services/sessionCoordinator.ts` / `stateSerializer.ts` | 只提交可完整恢复的批次；没有完整批次时保留现有来源、批次与回放。布局恢复独立进行 |
| 多源回放 | `services/sessionCoordinator.ts` / `playbackController.ts` | 同一实验批次内多个热工/BMS 来源默认整批严格同步；用户显式选择单源时原理图和大屏共享该来源的帧 |
| 数据场景持久化 | `components/ImportDataDialog.tsx` / `components/SaveManager.tsx` | 导入时默认发布到分析库；取消发布会明确提示场景不会保存该批数据。首次保存使用名称输入框，另存覆盖和删除都在应用内确认；确认期间锁定会改变目标/场景的操作，关闭或取消清除待确认项 |
| 测试不依赖 `data/` | 全部 `*.test.ts` | 见 §0-2 |
| 帧计数命名 | 大屏 | "时间对齐帧"与"热工字段齐备帧"是两个指标，**不要都叫「共同帧」** |
| 实时折线图布局 | `components/dashboard/lineChartLayout.ts` | 图例可横向滚动；时间刻度自动避让；网格为图例、绘图区和缩放条预留空间；双轴名称必须标出物理量和单位，不能把不同单位藏在同一轴名下 |
| 大屏响应式网格 | `analysis-dashboard.css` | 列数变化时同步调整卡片跨度并解除固定行定位；避免隐式列挤压内容，手机上指标卡单列、图表整行显示。舞台按图表内容保底并可纵向滚动，页脚始终位于图表之后 |
| `.m3-chart-empty` 必须被约束 | `analysis-dashboard.css` | 空态用 `position:absolute; inset:0` 覆盖在图表上。**任何可能容纳它的父级都必须是定位容器**（`.m3-chart-panel__body`、`.m3-chart-shell`）。否则绝对定位逃逸到视口、铺满 1600×857 盖住整页：文字重叠且整页无法点击。页面里除 EChart 外还有大量手写的 `<div className="m3-chart-empty">`。图表标题区允许标题换行，副标题单行省略并可悬停查看全文，图表主体占用剩余高度 |

## 6. 已知限制

- **动画开启时空闲占主线程约 45%**：来源是各 SVG 内置的 CSS 无限动画，不是 JS 循环
  （JS 侧已优化：12 条冗余 rAF 已消除、关闭动画时循环真正停摆、`injectFields` 改为单次建索引）。
  再降需要把 SVG 动画改成 CSS 驱动，是一次大重构。
- **「一键整理」只修了一半**：仪表归位已修，但重叠消解仍按遍历顺序挪卡片，
  可能挪错对象而不是用户最后操作的那张。
- **PDF 解析走主线程**（只有 XLSX 有 Worker），大 PDF 会卡 UI；worker 有 120s 超时但无进度反馈。
- `base-elements/` 下 `power-line.svg` / `refrigerant-line.svg` / `water-line.svg`
  是**永不渲染的死资产**（只被已弃用的 `index.html` 引用）。
- `presetVb` 字段名有历史误导（实际是世界坐标 px，不含 viewBox 语义、不乘 scale），已改注释未改名。
- 逐通道隔离**建议暂缓**：实测对本数据集严格同步帧数收益为 0（可恢复的行落在 BMS 时间窗之外），
  风险面却覆盖全链路。

## 7. 部署 / CI-CD

- GitHub Actions：`ci.yml`（verify）与 `release.yml`（verify → publish-image）
  都跑 typecheck → **unit tests + BMS Node API tests** → build；CI继续产物/镜像检查
- 旧 Docker Compose + SCP/SSH 自动部署已在 `release.yml` 中整体注释；`deploy/deploy.sh` 保留但不被调用
- 生产运行在 Kubernetes，镜像推 GHCR 后由运维手动 `kubectl set image`
- BMS模块默认关闭；启用需设备/观看凭据文件与PUBLIC_ORIGIN，开发与生产共用API模块；详见部署README的BMS独立实时模块章节
- 详见 [`deploy/README.md`](./deploy/README.md) 与 [`CICD持续集成部署.md`](./CICD持续集成部署.md)

## 8. 约定

- 所有文档、字段、注释用中文；SVG 内 `data-field` / `data-animation-id` 用英文（供 JS 查询）
- **不要提交计划文档/调研文档**。`.gitignore` 已用 `*.md` + 白名单隔离根目录文档
- 未获明确指示不要 `git add` / `git commit`
- 改动行为时同步更新本文件第 1 节（现状快照）与第 5 节（不变量）
