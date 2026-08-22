# AGENTS.md — 光伏·空调仿真平台

## 快速认知

- **中文项目**：所有文档、字段、注释均为中文。SVG 内 `data-field`、`data-animation-id` 属性用英文（供 JS 查询）。
- **工程已建好**：`apps/web/`（React 18 + Vite 5 + TS 5 + Zustand 4）。M2 阶段 `apps/server/` 尚未建。
- **当前阶段**：M2 数据读入启动（M1/M1.5 已完成）。仪表绑定 + 数据集 + 时序回放已落地。
- **三阶段路线图**：M1 原理图（✅）→ M1.5 动画收尾（✅）→ M2 数据读入（进行中）→ M3 数据大屏。

## 工程目录

```
apps/web/
├─ package.json                    React + Vite + TS + Zustand
├─ vite.config.ts                  开发服务器 (port 5173)
├─ vite-svg-plugin.ts              自定义 SVG 服务插件（serve base-elements/ 路径）
├─ tsconfig.json
├─ index.html
└─ src/
   ├─ main.tsx                      入口挂载
   ├─ App.tsx                       组件：TopBar + TimelineControls + PalettePanel + CircuitCanvas + ControlPanel + LogPanel + Tooltip
   ├─ styles.css                    全局样式（grid 布局 + 调色板 + 锚点 + 动画暂停 + timeline）
   ├─ components/
   │  ├─ CircuitCanvas.tsx          主画布（1800×1100），锚点层 + 直线线缆 + 粒子 + 部件 + 仪表
   │  ├─ ControlPanel.tsx           控制面板（15 滑块 + 9 预设 + 随机/重置）
   │  ├─ GridPattern.tsx            网格背景
   │  ├─ LogPanel.tsx               运行日志（每 5s 记录真实状态，贴底 40px）
   │  ├─ PalettePanel.tsx           左侧调色板（3 线缆 + 2 仪表）
   │  ├─ TimelineControls.tsx       M2-β 时序回放控制条（▶⏸ 播放/暂停 + 进度条 + 倍速 + 时间戳）
   │  ├─ Tooltip.tsx                鼠标悬停 200ms 显示部件信息
   │  └─ TopBar.tsx                 顶栏（时钟 + 动画开关 + 编辑模式 + 网格 + 保存 + 重置 + 状态快照）
   ├─ injector/injector.ts          TS 版 SVGs 注入器（与 base-elements/index.html 内联 JS 同步）
   ├─ store/simulation.ts           Zustand store（15 滑块 + 7 flag + 10 cable actions + 6 meter actions + animationOn + injectionDataset + timeline）
   ├─ services/
   │  ├─ injectionParser.ts         CSV/XLSX/PDF 解析（M2-β：优先 real time data sheet + trim 单元格）
   │  ├─ dataMapper.ts              NumericFieldKey + 列名→字段智能匹配 + applyMapping
   │  ├─ pdfFieldMap.ts             PDF 17 列 → store 字段 + 仪表绑定（M2-β：meterBind 映射）
   │  ├─ meterInject.ts             M2-β 仪表实例按 bind 从数据集当前行注入真实值
   │  └─ stateSerializer.ts         场景状态序列化
   ├── data/
   │  ├─ components.ts              12 固定部件 2×7 坐标 + SVG 文件映射 + VIEW_W=1800 / VIEW_H=1100
   │  ├─ cables.ts                  7 条 Cable（每条 1+ CableSegment，端点吸附到锚点）
   │  ├─ anchors.ts                 56 个 ComponentAnchor + getAnchorPosition + findNearestAnchor + SNAP_RADIUS=8
   │  ├─ palettes.ts                3 线缆 + 2 仪表调色板常量
   │  ├─ meters.ts                  MeterInstance 类型（mount: cable/component/free）+ M2-β MeterBind + PRESET_METERS（2 PM + 4 TS 预置）
   │  └─ presets.ts                 9 个预设场景
   ├─ engine/pcm.ts                PCM 相变材料视觉派生层（纯函数 derivePcmVisual：水箱温度 + 水泵 → melt/phase/温度/状态文字/色/过渡时长，无定时器；未来联动引擎替换内部实现）
   └─ hooks/
      └─ useParticleAnimation.ts    Canvas 粒子动画（沿多段拼接路径运动；animationOn=false 时隐藏）

base-elements/（18 SVG + index.html + injector.ts + 数据字段映射）
├─ 14 个部件 SVG
├─ 3 线缆 SVG + 1 总览 SVG
├─ index.html             旧版单文件演示（已弃用，保留作为 SVG 测试参考；由 demo.html 重命名）
├─ injector.ts            index.html 内联注入器的 TS 版
├─ README.md              视觉规范
└─ 数据字段映射.md         字段定义 + 动画驱动字段

data/（实验采集数据）
├─ 2026-07-14_*.pdf       力控导出电量数据（17 列）
├─ 2026-07-15_battery-pack.xlsx  电池 BMS 数据（36 列）
└─ 字段对照表.jpg         IO 点配置表
```

## 画布架构（M1 重构版）

### 整体布局
```
┌────────────────────────────────────────────────────────────────┐
│  TopBar  60px  (动画▶/⏸ + 编辑模式 + 网格 + 保存 + 重置 + 状态) │
├──────────┬──────────────────────────────────────┬─────────────┤
│  调色板  │           CircuitCanvas               │             │
│  160px   │           1800×1100 viewBox           │ ControlPanel│
│          │                                       │   320px     │
│  线缆区  │   行1: PV|CB|Grid|GS|IV|Bat|Load     │             │
│  仪表区  │   行2: HP|Tank|Pump|PCM|AT|PM|TS     │  滑块+预设  │
│          │                                       │             │
├──────────┴──────────────────────────────────────┴─────────────┤
│  LogPanel  40px 贴底 (hover 展开 160px 看历史)                  │
└────────────────────────────────────────────────────────────────┘
```

### 部件 2×7 坐标（viewBox 1800×1100）
| 列     | 100 | 340 | 580 | 820 | 1060 | 1300 | 1540 |
|--------|-----|-----|-----|-----|------|------|------|
| 行1 y=200 | pv-array | combiner-box | grid | grid-switch | inverter | battery | load |
| 行2 y=750 | heat-pump | tank | pump | pcm | air-terminal | power-meter | temp-sensor |

### 锚点系统（components.ts + anchors.ts）
- 每个部件 viewBox 240×240，按部件 scale 缩放
- 锚点 = 部件 4 边中点（top/bottom/left/right），共 14×4 = 56 个
- 锚点 id 格式：`{componentId}.{side}`，如 `pv-array.right`
- 吸附半径 **SNAP_RADIUS = 8** viewBox 像素
- 锚点渲染为 6×6 绿色方块（`.anchor-marker`），**默认隐藏**，拖线缆端点时显示

### 线缆模型（cables.ts）
```typescript
interface CableSegment {
  fromAnchorId: string;   // 锚点 id（组件锚点 "comp.side"）
  toAnchorId: string;
}

interface Cable {
  id: string;
  kind: 'power' | 'refrigerant' | 'water';
  segments: CableSegment[];   // 1+ 直线段，段间共享端点 = polyline
  meters: MeterInstance[];
  floatingFrom?: { x: number; y: number } | null;  // from 端浮动坐标
  floatingTo?: { x: number; y: number } | null;    // to 端浮动坐标
}
```

### 拖出 / 拖端点流程
- 用户从调色板拖出 → handleDrop 在落点 `findNearestAnchor`（8px 内）
  - 命中 → from 端吸附 + to 端浮动在落点（虚线预览）
  - 未命中 → from 端浮动在落点 + to 端浮动在落点
- 浮动端点显示**灰色虚线圆点**，等待用户拖动
- 拖动端点 → 全局 `cableDrag` 状态广播，canvas-svg 加 `.dragging-cable` class，最近吸附目标单独绘制高亮方框
- mouseup 时按 snap 结果调用 `updateCableEnd`（命中则吸附 + 清浮动；未命中则保留浮动）

### 7 条默认线缆（端点锚点映射，13 段全部无主体相交）
| Cable | 段 | from → to |
|-------|----|-----------|
| power-pv-iv | 3 | pv.right→cb.left, cb.bottom→gs.bottom, gs.bottom→iv.left |
| power-grid-iv | 2 | grid.right→gs.left, gs.right→iv.top |
| power-bat-iv | 1 | bat.left→iv.right |
| power-bat-load | 1 | bat.right→load.left |
| power-iv-hp | 2 | iv.bottom→tank.top, tank.top→hp.top |
| refrigerant-hp-tank | 1 | hp.right→tank.left |
| water-tank-pump-pcm-terminal | 3 | tank.bottom→pump.top, pump.right→pcm.left, pcm.right→at.left |

合计 **13 直线段**，7 逻辑线缆。CB→IV 走底部绕开 grid+gs 主体；IV→HP 用 tank.top 中转避免长对角。

### 调色板（PalettePanel.tsx）
- 线缆区：3 种线缆色块（红/绿/蓝），**HTML5 drag-and-drop 无限拖出**（不消耗）
- 仪表区：PM（黄色 A）+ TS（蓝色 T），拖出 → 画布创建 MeterInstance(mount='free')

### 仪表模型（meters.ts）
```typescript
interface MeterInstance {
  id: string;
  type: 'power-meter' | 'temp-sensor';
  mount: 'cable' | 'component' | 'free';
  cableId?: string;          // mount='cable'
  offsetOnCable?: number;    // 0..1
  anchorId?: string;         // mount='component'
  position: { x: number; y: number };
}
```

### 关键约束
- **仿真引擎是动画的唯一数据源**。`SimulationState` → injector → SVG 视觉。
- **PCM 相变材料 v0.4**：温度/融化比例由 `engine/pcm.ts` 的 `derivePcmVisual` 派生（输入水箱温度 + 水泵），注入器动画字段为 `pcm_anim_melt`（0~1）+ `pcm_anim_transition`（秒），相态走 `animStates.phase` → 根 g 的 `data-anim-phase-state`（solid/melting/liquid/freezing）。旧 `pcm_anim_temp` / `pcm_anim_temp_color` / `pcm_anim_phase` / `--anim-pcm-temp` / `--anim-pcm-color` / `pcm_liquid_color` / `pcm_frag_*` / `pcm_bubble_*` 已废除。
- **CSS `transform` 覆盖 SVG `transform`**。class="anim-xxx" 不能放在 `<g transform="translate(x,y)">` 上。
- **`injectAnimations` 通过 `[data-animation-id="${key}"]` 匹配**。SVG 没有对应 id → 变量不写 → 动画不工作。
- **SVG 根必须同时有 `data-component-id="xxx"`** 和 `data-animation-id`。
- **拖线缆端点吸附**：8px 内才吸附，否则浮动（端点坐标 = 鼠标位置）。
- **动画开关**：`animationOn: false`（默认）→ `.app[data-anim-on="false"] .canvas-svg *` 暂停所有 CSS 动画 + 粒子 hook 检测后粒子 opacity=0。
- **polyline 拼装**：两段不直接相连；用户必须分别拖两端到同一组件锚点（如 cb.left + cb.right 实际是不同位置但同一组件）。

## 部署 / CI-CD

当前生产运行在 Kubernetes。GitHub Actions 负责验证、构建并把版本镜像推送 GHCR；旧的 Docker Compose + SCP/SSH 自动部署 Job 已在 `release.yml` 中整体注释保留。GHCR 发布成功后，由运维人员在 Kubernetes 服务器手动执行 `kubectl set image`，使用 `kubectl rollout status` 检查，使用 `kubectl rollout undo` 回滚。完整文档：

- 顶层：[`CICD持续集成部署.md`](./CICD持续集成部署.md)
- 运维：[`deploy/README.md`](./deploy/README.md)
- 旧流程归档：[`deploy/LEGACY-MANUAL.md`](./deploy/LEGACY-MANUAL.md)

发布触发：`git tag -a v0.2.3 -m "Release v0.2.3" && git push origin v0.2.3` → 校验 Tag 属于 main → verify → GitHub 构建并推送 GHCR 镜像。生产更新：`kubectl -n cloud set image deployment/pv-ac-sim-web pv-ac-sim-web=ghcr.io/mike666wq/photovoltaic-air-conditioner:v0.2.3` → `kubectl rollout status`。

Kubernetes Namespace 为 `cloud`，Deployment 与容器名均为 `pv-ac-sim-web`。一行回滚：`kubectl -n cloud rollout undo deployment/pv-ac-sim-web`。旧 `docker-compose.yml` 与 `deploy/deploy.sh` 当前保留但不参与生产发布。

## 启动命令

```bash
cd apps/web
pnpm install           # 安装依赖
pnpm dev               # 启动开发服务器 → http://localhost:5173
pnpm typecheck         # TypeScript 类型检查
pnpm build && pnpm preview  # 生产构建 + 预览
```

## 数据注入模式

```
CircuitCanvas useEffect 链：
  fetch SVG → DOMParser → <svg> 元素
  buildInjectData(state) → { fields, status, levels, animations, animStates }
  对每个 [data-animation-id] 节点：设 CSS 变量 / HTML 属性
  对每个 [data-field] 节点：设 textContent / fill（按字段类型）
  设根 data-anim-state（基于 state flags）
  cloneNode → 渲染到 ComponentSlot ref
```

## SimulationState

```typescript
// 滑块参数（15 个；pcm_temp 已退出控制面板，保留为遗留字段显示链路不消费）
pv_power, pv_sun, iv_power, bat_soc,
hp_temp, hp_power, tank_temp, tank_volume, tank_flow,
pump_flow, at_temp, pcm_temp,    // pcm_temp 遗留：仿真引擎初始化/M2 数据接入保留
pl_flow, rl_flow, wl_flow

// 部件 flag（7 个）
pv_on, cb_connected, gs_on, hp_on, pump_on, load_on
at_mode: 'cool' | 'heat' | 'off'

// 画布
positions: Record<string, {x,y}>   // 用户拖拽后覆盖静态坐标
editMode: boolean                  // 部件可拖拽模式
showGrid: boolean
animationOn: boolean               // 全局动画开关（默认 false）

// 线缆 / 仪表
cables: Cable[]                    // 7 默认 + 用户拖出
meters: MeterInstance[]            // 用户拖出
selectedCable: string | null
selectedMeter: string | null
```

## 已知陷阱

1. **浏览器缓存 SVG** — `vite-svg-plugin` 设 `Cache-Control: no-cache`，如未更新需 `Cmd+Shift+R`
2. **CSS `transform` 覆盖 SVG `transform`** — class 放 `<polygon>` 而非 `<g transform="...">`
3. **`index.html` 内联 injector 与 `injector.ts` 必须同步** — 两处代码独立
4. **ControlPanel 滑块用 `useSimStore((s) => s[field])` 订阅**
5. **LogPanel 用 `useSimStore.getState()` 真实值**
6. **drop 事件要在 React 合成事件 + 浏览器原生事件都阻止默认**，否则浏览器会打开新标签
7. **drag 时 cursor** — palette 用 `grab/grabbing`，画布吸附锚点用 `move`
8. **`vite-svg-plugin` 只在 dev 模式工作，build 需 `copyBaseElementsToDist()`** — `package.json` build 脚本引用了此函数
9. **SVG fetch 异步完成才注入** — `ComponentSlot` 的 useEffect 依赖 `[comp.id]` 和 `[svgContent, state]`
10. **动画开关与 CSS 优先级**：使用 `!important` 保证 `.app[data-anim-on="false"]` 覆盖 SVG 内 CSS

---

## M1.5 动画层收尾（Round 8 — 待启动）

2026-07-21 审计发现 **8 处动画 BUG**（4 错配 + 4 缺失），按优先级修复：

### Round 8 待办（5 步）

| 步 | 文件 | BUG | 修复 |
|---|------|-----|------|
| **2-1** | `CircuitCanvas.tsx:200` `buildInjectData` `grid_anim_state` | 注入 `online`/`offline`，SVG 期望 `on-grid`/`offline` | 改注入值为 `state.gs_on ? 'on-grid' : 'offline'`（实际生成位置在 CircuitCanvas，不是 injector） |
| **2-1** | `CircuitCanvas.tsx:208` `buildInjectData` `animStates.mode` | Inverter 写 `data-anim-mode-state`，SVG 期望 `data-anim-iv-mode`（**注意无 `-state` 后缀**） | `buildInjectData` 内 `animStates.mode` 改键名为 `iv-mode`，或 SVG 内 CSS 选择器改为 `[data-anim-mode-state]` |
| **2-1** | `injector.ts:126-129` `at_anim_fan_speed` | 写 `--anim-at-fan-duration`，SVG 用 `--anim-fan-duration` | 注入器变量名去掉 `at-` 前缀 |
| **2-1** | `CircuitCanvas.tsx` `buildInjectData` + `injector.ts` `injectAnimStates` | tank SVG 硬编码 `data-anim-pump-running="true"`（行 146，CSS 行 68/84/95 全依赖） | `injectAnimStates` 增加 `pump-running: state.pump_on ? 'true' : 'false'` 映射；或改注入器键名（注意：当前 `impeller` 键→`data-anim-impeller-state` 不匹配 tank SVG） |
| **2-2** | `CircuitCanvas.tsx` | `useParticleAnimation` hook 已写 163 行但**未挂载** | 加 `<canvas>` + 调用 hook + 接 pl/rl/wl 滑块 |
| **2-3** | `tank.svg:105` | `.anim-tank-steam` CSS 永久 `opacity:0` | 改 `[data-anim-pump-running="true"] .anim-tank-steam { opacity: 0.4 }` |
| **2-4** | `CircuitCanvas.tsx:52-213` `buildInjectData` | load.svg 6 字段未消费（`real_clock`/`fridge_status`/`fridge_temp`/`lamp_glow`/`lamp_led`/`load_power_bar`） | 加 field + color/level 处理 |
| **2-6** | — | M1.5 验收 | typecheck + build + 14 部件 + 3 线缆 + 9 预设动画全通 |

### 跳过（M1.5 范围外，推迟到 M2 启动后）

- ❌ `pv_anim_panel_speed`（板反光扫动）— 见 `部件动画增强.md §2`
- ❌ `hp_anim_compressor_pulse`（压缩机脉动）— 见 `部件动画增强.md §6`
- ❌ `at_anim_fan_color`（末端风盘颜色）— 见 `部件动画增强.md §8`

### M1.5 文件改动清单

```
apps/web/src/
├─ injector/injector.ts          # 2-1: 4 处键名修复 + 2-3: pump-running 注入
├─ components/CircuitCanvas.tsx  # 2-2: 挂载粒子 hook + 2-4: load 字段注入
└─ hooks/useParticleAnimation.ts # 2-2: 验证 hook 可挂载（如有问题同步修复）

base-elements/
└─ tank.svg                       # 2-3: .anim-tank-steam CSS 启用
```

### 已知缺陷（已在审计中确认，本轮不动）

- `index.html` 内联 injector 用 `key.includes('fan')` 通配，`injector.ts` 用精确键名 — 两处实现不一致导致 index.html 内 `hp_anim_fan` 也能命中，但 injector.ts 不会。**接受**（index.html 已弃用）
- SVG 内 `cb_anim_*` / `gs_anim_*` 10+ 个动画键完全不被 injector 处理 — 仅靠 `data-anim-state` 根属性切换可见性。**接受**（M1.5 范围外）

## M1.5 Round 10-11 总结

2026-07-22 完成 25 项跨角度审计修复。

### 业务逻辑（10 项）
- **能量流独立字段（M2 准备）**：
  - 新增 `load_power_kw`（0~3 kW，驱动负载条 + 负载摘要）
  - 新增 `battery_power_kw`（-3~3 kW，正=放电/负=充电/0=待机，驱动电池状态 + 流向）
  - 新增 `grid_online`（独立于 `gs_on`，驱动电网 SVG 状态）
  - 取代原 `pv_power` 误驱动负载/电池方向/PM 三相
- **拓扑完整性**：
  - `removeCable` 清理被引用 cable 的 `cable:*` 端点（写 floating 备份）
  - `removeMeter` 写 floatingFrom/floatingTo（不再清空即消失）
- **API 修正**：
  - `cycleLoad` 改名为 `toggleLoad`（一致性）
  - `setField` 类型收紧到 number/boolean
- **Preset 完整化**：9 个预设含 7 flags + at_fan_speed + 3 能量字段

### 动画（4 项）
- HP off 状态正确门控所有动画（`data-hp-on` 注入）
- AT 风扇档位驱动空气粒子（`--anim-air-speed` 全链路）
- CB 输入 LED 随 `pv_power` 变化（`--anim-pv-inputs` 注入）
- TS 温度源统一为 `tank_temp`（与 index.html 一致）

### 交互（4 项）
- Edit mode 真正锁定卡片拖动
- Esc 取消拖动
- Cable drop 后清理 cableDrag 残留
- Slider 加 `aria-label`

### 已知遗留
- `selectedId`/`draggingId`/`hoverId` 三个 state 字段为历史遗留，无消费者
- `showCoords`/`gridSize` 仍为孤立字段（M2 启动后清理）
- `loadLayout` 不清理旧 cardPositions 与 localStorage（M2 启动后统一持久化）

## M1.5 Round 12-13 完成总结

2026-07-22 完成 18 文件改动。

### Round 12 — 文件存储 + 页面级网格

**新增 5 文件**：
- `data/saveSchema.ts` — 持久化类型（含 injection 架构占位）
- `services/stateSerializer.ts` — 序列化/验证/迁移
- `services/fileStorage.ts` — File System Access API + blob 兜底 + input 读取
- `services/recentFiles.ts` — 最近文件 localStorage 索引（仅元数据，不存实际内容）
- `components/SaveManager.tsx` — 状态文件管理 modal

**修改 5 文件**：
- `components/TopBar.tsx` — "💾 状态" 按钮触发 SaveManager modal
- `components/App.tsx` — 移除旧 `loadLayout()` 调用
- `store/simulation.ts` — 删除旧 `saveLayout` / `loadLayout` / `LAYOUT_STORAGE_KEY`
- `styles.css` — SaveManager modal 样式 + 4 面板半透明
- `components/CircuitCanvas.tsx` — 移除 canvas-bg 内 GridPattern（移到 App 级别）

**新增 1 文件**：
- 无（页面级网格用 CSS pseudo-element）

**修改 1 文件**：
- `App.tsx` — 加 `.app-grid` 类（条件 `showGrid`）
- `styles.css` — `.app::before` 全页面级 grid + `.app > *` z-index 1 + 4 面板半透明

### Round 13 — 部件内部页 + 数据注入启动

**新增 3 文件**：
- `components/ComponentDetail.tsx` — 部件详情全屏 modal；左侧 14 部件列表可快速切换；右侧主区显示当前状态 + 数据报表占位
- `services/injectionParser.ts` — CSV 解析器（含引号字段、UTF-8 BOM）；xlsx 暂未启用（友好错误提示）
- `services/dataMapper.ts` — `NumericFieldKey` 类型（17 数值字段） + `autoMapColumn`（智能匹配） + `applyMapping`（NaN 过滤 + `at_fan_speed` 整数化）

**新增 1 文件**：
- `components/ImportDataDialog.tsx` — 4 步向导：选文件 → 预览 → 列映射 → 预览注入值 → 应用

**修改 3 文件**：
- `components/ComponentDetail.tsx` — "📥 导入数据" 按钮启用；挂载 ImportDataDialog
- `store/simulation.ts` — 新增 `lastInjection` 字段 + `applyInjection` action
- `styles.css` — ImportDataDialog 样式（z-index 1001，避免与 ComponentDetail 冲突）

### 关键设计决策

1. **文件优先于 localStorage**：场景状态完全以 JSON 文件保存，localStorage 仅存最近文件索引（名称+时间戳+filename，不存内容）。
2. **原子 applyDocumentToStore**：载入文件时一次性 setState 应用所有 17 数值 + 7 flags + at_mode + layout + preferences，并清 transient 状态。
3. **数据注入暂不做时序**：Round 13 只把选中列的最后/首行/平均值注入 store，不做时序播放。
4. **双击进入内部页**：单击仍走原有状态切换，双击触发 modal 打开（接受 2 次 onClick 副作用，净效果 = 0）。
5. **预留 injection 架构**：saveSchema 中 `injection: { sourceFile, rowsCount, ... } | null` 字段，M2 完整数据读入时填充。

### 已知遗留（M2 阶段处理）

- xlsx 解析（已引入 SheetJS，`real time data` sheet 优先 + trim 单元格）
- PDF 解析（已引入 pdfjs-dist）
- 时序数据 → 部件动画回放（已落地，见 TimelineControls）
- 部件内部页图表（时间序列）
- 统一统计报表页
- 路径字段持久化（暂不存）

## M2-β 数据读入启动总结（仪表绑定 + 数据集 + 时序回放）

2026-07-31 完成。本阶段实现"所有采集数据都包含在原理图中"的核心链路。

### 新增/修改文件

```
apps/web/src/
├─ data/meters.ts               # +MeterBind（meter-d/meter-du/env-temp/supply-temp/return-temp/outlet-temp）
│                               # +METER_BIND_LABELS + TEMP_BIND_PDF_COLUMN + PRESET_METERS（2 PM + 4 TS 预置）
├─ store/simulation.ts          # +injectionDataset（完整数据集） + timelineIndex/Playing/Speed + pcm_temp_select
│                               # +setInjectionDataset/clearInjectionDataset/setTimelineIndex 等 actions
│                               # meters 默认值 = PRESET_METERS（预置仪表）
├─ services/meterInject.ts      # 新：buildMeterInjectData(state, meter) 按 bind 从数据集当前行取真实值
│                               #   readCell/getCurrentRow/buildPcmInjectData/normTemp
├─ services/pdfFieldMap.ts      # +meterBind 列（D1/D2/D3/D6→meter-d，DU→meter-du，T0/T1→pcm）
│                               # +METER_BIND_COLUMNS + PCM_COLUMNS + readPdfNumericCell
├─ services/injectionParser.ts  # parseXLSX 优先 'real time data' sheet + trim 单元格（' 无'→'无'）
├─ components/CircuitCanvas.tsx # MeterSlot 按 bind 注入（buildMeterInjectData）；预置仪表 presetVb 缩放
│                               # buildInjectData 读取 XLSX 电压/电流/SOC + PCM T0/T1 切换 + 单击 PCM 切换
├─ components/TimelineControls.tsx  # 新：▶⏸ 播放/暂停 + 进度条 + 倍速 1/2/4/8 + 时间戳显示
│                               #   applyRowToStore：列→字段自动映射后逐行写入 store
├─ components/ComponentDetail.tsx   # 数据报表（数据集摘要 + 当前帧附近表格）+ battery/pcm 真实值
├─ components/ImportDataDialog.tsx  # 确认时 setInjectionDataset 存完整数据集；PDF 导入不受部件白名单限制
├─ components/TsPointer.tsx         # 指针按绑定从数据集读温度（不再硬编码 tank_temp）
├─ App.tsx + styles.css             # +TimelineControls 布局（grid-template-rows: 60px auto 1fr 40px）
base-elements/
├─ power-meter.svg               # 3 圆盘改 V/A/kW（pm_l1=电压/l2=电流/l3=功率）+ P total kW
├─ pcm.svg                       # LCD 显示 pcm_temp_select（T0/T1）+ 单击切换
└─ battery.svg                   # LCD 右侧新增 bat_voltage/bat_current
```

### 字段 → 仪表绑定映射（PDF 14 列全部有载体）

| PDF 列 | 载体 | 显示 |
|--------|------|------|
| T0.PV / T1.PV | PCM | 单击切换 T0/T1，LCD 显示 pcm_temp_select + 温度 |
| T2.PV 出风 | TS-outlet | 预置温度检测器（AT 旁） |
| T3.PV 环境 | TS-env | 预置温度检测器 |
| T4.PV 送水 | TS-supply | 预置温度检测器（水箱旁） |
| T5.PV 回水 | TS-return | 预置温度检测器（水箱旁） |
| D1/D2/D3/D6 | PM-meter-d | 圆盘 V/A/kW + P total |
| DU1/DU2/DU3/DU6 | PM-meter-du | 圆盘 V/A/kW + P total |
| ZU/ZI/ZW（离线） | — | 恒 0，UI 不误导 |

### 关键约定

1. **仪表实例带 `bind`**：MeterSlot 注入用 `buildMeterInjectData`（按 bind 从数据集取真实值），不再用全局 buildInjectData 的 pm_*/ts_* 字段。
2. **预置仪表**：`PRESET_METERS` 带 `presetVb`（viewBox 逻辑坐标），渲染时按 canvas 缩放；用户拖动后 presetVb 清除改用像素坐标。
3. **时序回放**：TimelineControls 每帧 `applyRowToStore`（列→字段自动映射）写 store → CircuitCanvas 因 state 变化自动重注入全部 SVG + 仪表。
4. **PCM 单击切换**：CLICK_ACTIONS['pcm'] = 切换 pcm_temp_select；buildPcmInjectData 从 T0/T1 原始列取温度。
5. **数据集是唯一数据源**：injectionDataset 存完整原始行 + 时间列；仪表显示 / 部件动画 / 大屏图表都从它读取。

### 已知限制

- 时序回放按"行"推进（每帧 1 行），PDF 120s/行、XLSX 2s/行 的实际时间间隔通过时间戳体现，倍速仅控制帧推进速度。
- PDF 直流 3 列（ZU/ZI/ZW）传感器离线恒 0，UI 显示 0 而非误导。
- XLSX `电流(A)` 在 applyRowToStore 会覆盖 `battery_power_kw`（历史 alias），但 buildInjectData 优先读原始列，显示正确。

## SVG 视觉规范

- `viewBox="0 0 240 240"`，透明背景，等轴视图 30°
- 金属主体 `#D1D5DB`→`#4B5563`，侧边 `#374151`
- 电力线 `#E63946` / 制冷剂 `#2A9D8F` / 水线 `#1D6996`
- 每部件有顶部黑色标识牌 + 底部白色标签
