# AGENTS.md — 光伏·空调仿真平台

> 面向 AI 编码助手的工程规约。**与代码冲突时以代码为准，并顺手修正本文档。**
> 最后核对：2026-10-04（对应 `apps/web` 现状）

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
| 阶段 | M1 原理图 / M1.5 动画 / M2 数据读入 / M3 数据大屏；独立设备只读监控接入实验与BMS多设备 |
| 路由 | `/`（原理图）、`/analysis`（数据大屏，懒加载）、`/monitoring`（统一登录/管理员工作台/设备列表，懒加载）、`/monitoring/devices/:deviceId`（单设备观测，懒加载）、`/experiment/realtime`与`/bms/realtime`（转到对应分类列表）、`/monitoring/manage`与`/bms/manage`（管理与接入别名，懒加载） |
| 部件 | **13** 个（`data/components.ts`） |
| 预设 | **9** 个 + 🎲 随机扰动（`data/presets.ts`） |
| 控制面板滑块 | **21** 个 |
| 预置仪表 | **6** 个（2 功率检测器 + 4 温度检测器） |
| 默认回放 | 一个实验批次内的多数据源共享严格同步时间轴；大屏单源模式同步切换回放来源 |
| 验收夹具 | 测试现场生成同构数据，不读取被忽略的 `data/` |
| 源码头 | 124 个 action（`store/simulation.ts`） |
| 测试 | `vitest run` 与 `node --test scripts/realtime/*.test.mjs` 均通过才算完成 |
| 实时监控 | 实验与BMS设备独立注册、不配对；管理员工作台并列管理/观测入口，观察用户只见获授权列表；点击设备才创建租约，一页一设备；与仿真/分析状态隔离 |
| 实时缓存 | BMS与实验点共用进程内缓存协调器；观测保留最多1小时、45秒观看租约；`BMS_REALTIME_MAX_CACHE_POINTS` 默认500,000点、`BMS_REALTIME_MAX_CACHE_BYTES` 默认128MiB估算预算，超限拒绝新数据；生产仅支持单Node进程/单副本Recreate |
| 实时趋势断点 | BMS趋势逐观测保留可选`periodSeconds`；相邻间隔超过前点有效周期的1.5倍（至少30秒）才断线，前点无有效周期时次选当前点有效周期、两者都无效时回退30秒。实验趋势仅画实际观测，不按时间间隔插入断点或点；来源、会话和实际null/失败仍断线。孤立有效点显示标记，密集曲线不逐点显示标记 |
| 管理与接入 | 管理员管理独立设备与账户、原子保存逐设备授权及启停状态、重置他人密码；旧整体权限只读映射，编辑账户后转为显式设备集合；设备令牌仅创建/轮换时显示并可下载Windows手动配置说明 |
| 并发限制验收 | 每账户最多4个跨模块共享活动页面、最多10个活动观看账户；每账户8条SSE、每模块40条租约；无pageId旧客户端每条租约计为独立页面。10账户×4页双路80租约、约2800请求/分钟的生成负载测试已通过 |
| 真实设备验收 | Windows真实客户端现场上传量和正式HTTPS联合验收仍待完成；生成负载夹具只验证服务端限额处理，不代表现场测点或真实上传量已实测 |
| 大屏布局 | 桌面 12 列；窄屏 6 列并按断点调整指标卡和图表跨度，不生成隐式列；舞台内容超高时纵向滚动；实时折线图共享可滚动图例和防重叠时间轴 |
| 移动端 | 窄屏（≤900px）原理图工具收纳进菜单、参数/部件抽屉互斥；手机首入全图，空白处单指平移、双指缩放，点按查看部件；复杂拖动/线缆/框选提示建议电脑操作；分析、监控、管理页按视口回流，宽表在自身横向滚动 |
| 原生客户端 | Android10+ Kotlin WebView与Windows10/11x64 WinForms WebView2外壳在clients目录；独立client-v标签构建安装包，后台生命周期/返回/文本保存通过固定HTTPS同源主框架桥；尚待平台构建及两端真机验收，不代表已发布 |
| 部署版本 | 所有页面页眉显示版本标识；Release Docker 构建注入 Git tag 与完整 SHA，点击查看短 SHA；本地开发显示开发版与短 SHA/未知，不从 package.json 或线上查询推断版本 |

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

优先使用可用的浏览器自动化工具；工具不可用时可用本机已有Playwright/Chromium（不下载浏览器），再打开本地地址
`http://127.0.0.1:5173/analysis`。通过页面文件选择器上传现场生成的 CSV/XLSX/PDF 夹具，
从可见 DOM 检查导入状态、帧数和图表；测试不得依赖被忽略的 `data/` 文件。

注意事项：
- 跨页面验证使用应用内 SPA 导航，不要整页重载：zustand 是内存态，重载会清空已导入数据；
- 不要通过动态 `import('/src/...')` 读取 store，模块可能是另一个实例；以页面 DOM 为准；
- 无头环境下 `requestAnimationFrame` 会被节流，需要定时器的地方不能用它。

## 3. 架构

```
apps/web/src/
├─ pages/          SchematicPage（原理图）、AnalysisDashboardPage（大屏）、MonitoringPage（登录/工作台/设备列表）、MonitoringDevicePage（单设备观测）、ExperimentRealtimePage、BmsRealtimePage、BmsManagePage（管理与接入）
├─ components/     TopBar / TimelineControls / CircuitCanvas(1998行) / ControlPanel /
│                  PalettePanel / ComponentDetail / ImportDataDialog / SaveManager /
│                  LogPanel / Tooltip / ToastContainer / TsPointer / GridPattern /
│                  CableControlDetail / CableControlItem
│                  ├─ dashboard/  ChartPanel / EChart / MetricCard
│                  └─ bmsRealtime/ BmsTrendChart / MonitoringTrendChart / 接入向导
├─ hooks/          useParticleAnimation / usePvSunAnimation / useTransientSpark /
│                  useModalA11y / useTimelinePlayback
├─ engine/         canvasGeometry / orthogonalRouter / particleMotion / powerFlow /
│                  alignment / schematicControl / pcm
├─ injector/       injector.ts（SimulationState → SVG 视觉的唯一通道）
├─ services/       数据管线：injectionParser / dataSourcePipeline / playbackSession /
│                  playbackController / schematicFrame / meterInject / analysisSeries /
│                  operationalDiagnostics / sessionCoordinator / sourceCache / experiment* /
│                  stateSerializer / dataset / batteryConvention / preparedImport / bmsRealtime*
├─ store/          simulation（主状态）、analysis（数据源/批次/口径）、toast、bmsRealtime / experimentRealtime（隔离实时态）
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
| 实时数据隔离与口径 | `bmsRealtime*` / `experimentRealtime*` / `scripts/realtime/` | 独立设备观测均为只读：BMS保留centiV/centiA/centiAh与原始温度，实验源按 `point-contract.json` 保留质量、单位与逐点时间；不读写simulation/analysis/injector；设备只有有效观看租约时才上传，心跳不代表测点采集；租约TTL使用服务端单调时钟 |
| 实验质量与缓存 | `experimentRealtimeTypes.ts` / `experiment-state.mjs` / `ExperimentRealtimePage.tsx` | 实验点好坏仅依本地quality；good值（含零值/RAW显示）不因年龄自动变无效，stale/失败/未知依原质量展示。单调年龄仅用于显示距采集时间与一小时缓存到期；缓存到期后点和值移除，缓存时长不代表数据新鲜度。趋势只绘制实际点，不按时间间隔插点或制造断点；来源、会话和实际null/失败仍断线 |
| 独立设备授权与旧兼容 | `routes.mjs` / `registration.mjs` / `MonitoringPage.tsx` | 管理员有效权限为全部注册设备，观察用户仅逐设备权限与既有绑定的旧整体权限映射；启动不改写文件，新设备不自动授权；编辑账户原子保存最终设备集合并清除monitoringAccess；旧系统绑定PUT返回410；列表不创建租约，撤权只结束相应设备观看且保留其他合法会话；删除后同编号重注册不恢复旧授权 |
| 共享缓存与容量 | `cache-coordinator.mjs` / `state.mjs` / `experiment-state.mjs` | BMS与实验观测共用1小时进程内缓存及容量账本；默认最多500,000点、每点按1,024字节估算、总估算128MiB，环境变量可设上限；超限以503拒绝新观测且不部分更新；当前仅单Node进程、K8s单副本Recreate，多实例前须共享租约、缓存、去重与发布订阅 |
| 管理与注册 | `BmsManagePage.tsx` / `registration.mjs` / `registry.mjs` | 首个管理员须初始化密钥+同源CSRF且仅一次；管理员管理设备与账户、逐设备权限、停用和密码重置（不能自重置）；落盘成功才更新运行态；令牌只在注册/轮换成功时临时显示，禁止持久化或写日志；删除设备移除其逐设备授权、绑定与缓存，但保留账户整体监控授权；本地采集记录不删除 |
| 并发产品限制 | `auth.mjs` / `routes.mjs` | 每账户最多4个活动`pageId`，同一页面可各持有BMS与实验模块一条租约；最多10个活动观看账户；每账户最多8条SSE，每模块最多40条租约。旧客户端不传`pageId`时每条租约按独立页面计数。`BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE`按账户限流，默认5000次/分钟、最大可配置10000。10账户×4页面双路80租约及约2800请求/分钟生成负载测试通过；现场Windows上传量和HTTPS联调仍待验收，不得以生成数据代替实测 |
| 电池符号唯一入口 | `services/batteryConvention.ts` | 用户口径（analysis store）→ 原理图内部口径（正=放电），三处调用统一走它，`unknown` 返回 null 不猜方向 |
| 导入三态反馈 | `AnalysisDashboardPage` | 全成功✓ / 部分⚠ / 全失败✕，**不要无条件加绿勾** |
| 弹窗无障碍 | `hooks/useModalA11y.ts` | Esc/Tab 只由最上层弹窗处理；关闭子层恢复父层触发按钮焦点。`ComponentDetail` 是**常驻挂载内部 return null**，`open` 必须传真实状态 |
| 场景会话恢复 | `services/sessionCoordinator.ts` / `stateSerializer.ts` | 只提交可完整恢复的批次；没有完整批次时保留现有来源、批次与回放。布局恢复独立进行 |
| 多源回放 | `services/sessionCoordinator.ts` / `playbackController.ts` | 同一实验批次内多个热工/BMS 来源默认整批严格同步；用户显式选择单源时原理图和大屏共享该来源的帧 |
| 数据场景持久化 | `components/ImportDataDialog.tsx` / `components/SaveManager.tsx` | 导入时默认发布到分析库；取消发布会明确提示场景不会保存该批数据。首次保存使用名称输入框，另存覆盖和删除都在应用内确认；确认期间锁定会改变目标/场景的操作，关闭或取消清除待确认项 |
| 测试不依赖 `data/` | 全部 `*.test.ts` | 见 §0-2 |
| 帧计数命名 | 大屏 | "时间对齐帧"与"热工字段齐备帧"是两个指标，**不要都叫「共同帧」** |
| 自动来源与历史断点 | `realtimeSource.ts` / `experiment-state.mjs` / 实时页面 | 合法simulation上传不受旧许可开关限制；按仪器或地址/Pack以acceptedOrder自动跟随来源，不跨来源补值；当前含模拟时醒目标记；BMS趋势按逐点`periodSeconds`阈值识别时间空档，周期缺失时沿用30秒规则；实验趋势不按时间间隔判空档或插点，仅在来源/会话变化及本地null/失败观测处断开，缺点期间来源翻转通过`sourceSegment`防重连；BMS最新观测保留1小时；连续失败最多8次自动重连，之后需手动恢复 |
| 实时趋势采样周期 | `state.mjs` / `experiment-state.mjs` / `bmsRealtimeTypes.ts` / `MonitoringTrendChart.tsx` | BMS趋势API逐点保留原始`periodSeconds`，周期不从最新快照反推历史；断点判断优先使用前一观测的有效周期，前点周期缺失时才使用当前点，否则30秒；容差为`max(30秒, 声明周期×1.5)`。实验v1没有周期字段或周期驱动采样/断点；仅实际来源、会话、null/失败形成断点。孤立点（包括零值）必须可见，连续曲线避免全量标记；时间差提示可由时钟偏差、上传延迟或历史缓存回传造成，保留原始采样时间 |
| 实时折线图布局 | `components/dashboard/lineChartLayout.ts` | 图例可横向滚动；时间刻度自动避让；网格为图例、绘图区和缩放条预留空间；双轴名称必须标出物理量和单位，不能把不同单位藏在同一轴名下 |
| 大屏响应式网格 | `analysis-dashboard.css` | 列数变化时同步调整卡片跨度并解除固定行定位；避免隐式列挤压内容，手机上指标卡单列、图表整行显示。舞台按图表内容保底并可纵向滚动，页脚始终位于图表之后 |
| `.m3-chart-empty` 必须被约束 | `analysis-dashboard.css` | 空态用 `position:absolute; inset:0` 覆盖在图表上。**任何可能容纳它的父级都必须是定位容器**（`.m3-chart-panel__body`、`.m3-chart-shell`）。否则绝对定位逃逸到视口、铺满 1600×857 盖住整页：文字重叠且整页无法点击。页面里除 EChart 外还有大量手写的 `<div className="m3-chart-empty">`。图表标题区允许标题换行，副标题单行省略并可悬停查看全文，图表主体占用剩余高度 |
| 窄屏交互与状态 | `styles.css` / `CircuitCanvas.tsx` / `store/simulation.ts` | 首页手机首屏全图；触摸只在空白处平移或缩放，不捕获部件 pointer；真实触屏点按可查看部件/仪表详情、不切换仿真状态，桌面鼠标行为不变。旋转仅更新可视区域尺寸，不自动重置 pan/zoom 或业务数据。窄屏打开参数或部件抽屉会关闭另一个，Esc 可关闭并返回菜单焦点；不把全页遮罩用于抽屉。卡片拖动、线缆与框选仍建议电脑完成 |
| 部署版本可信来源 | `DeploymentVersion.tsx` / `Dockerfile` / `.github/workflows/release.yml` | Release 界面版本与提交 SHA 来自 GitHub tag 和 `github.sha` 构建参数；点击版本徽标能看到短 SHA。开发未注入元数据时明确显示开发版与 SHA 未知；禁止从 `package.json` 固定版本或网络“最新版本”生成部署标识 |

| 客户端桥与发布 | `clients/` / `nativeClient.ts` / `client-build.yml` | 固定HTTPS同源主框架，限制消息类型、文件名及1MiB文本；不输出令牌正文；后台暂停监控和回放，前台回放需手动继续；签名密钥不进仓库，未配置则拒绝release。client-v标签独立于云端镜像发布，真机试装通过后才正式发布 |

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
- BMS模块默认关闭；网页注册启用需独立持久注册目录、初始化密钥文件与PUBLIC_ORIGIN；旧设备/观看只读凭据文件仍兼容，开发与生产共用API模块；详见部署README的BMS独立实时模块章节
- 详见 [`deploy/README.md`](./deploy/README.md) 与 [`CICD持续集成部署.md`](./CICD持续集成部署.md)

## 8. 约定

- 所有文档、字段、注释用中文；SVG 内 `data-field` / `data-animation-id` 用英文（供 JS 查询）
- **不要提交计划文档/调研文档**。`.gitignore` 已用 `*.md` + 白名单隔离根目录文档
- 未获明确指示不要 `git add` / `git commit`
- 改动行为时同步更新本文件第 1 节（现状快照）与第 5 节（不变量）
