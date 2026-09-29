# base-elements · 立体草图库

> 项目代号：Photovoltaic‑Air‑Conditioner Sim Platform
> 阶段：M1 视觉规范（应用已演进到 M3，SVG 规范本身仍适用）
> 文档版本：v0.3（文件清单与实际引用情况对齐）
> 最后核对：2026‑09‑28
> 关联文档：[`../AGENTS.md`](../AGENTS.md)、`../电路实现逻辑.md`、`数据字段映射.md`

---

## 1. 用途

本目录存放 **原理图（`../原理图.jpg`）中所有部件 + 三类线缆的立体草图**，作为前端阶段 1 静态可视化页面的直接视觉资源。所有草图均为 **SVG 伪 3D 风格（等轴视图 + 渐变 + 阴影）**，可直接被 React 引用或独立预览。

## 2. 文件命名规范

`<类型英文>-<部件英文>.svg`

| 部件中文 | 文件名 |
|----------|--------|
| 光伏阵列 | `pv-array.svg` |
| 汇流箱 | `combiner-box.svg` |
| 电网 | `grid.svg` |
| 并网开关 | `grid-switch.svg` |
| 双向逆变器 | `inverter.svg` |
| 蓄电池 | `battery.svg` |
| 室内用电设备 | `load.svg` |
| 热泵机组 | `heat-pump.svg` |
| 水箱（盘管） | `tank.svg` |
| 循环水泵 | `pump.svg` |
| 相变材料 | `pcm.svg` |
| 末端（风机盘管） | `air-terminal.svg` |
| 功率检测器 | `power-meter.svg` |
| 温度检测器 | `temp-sensor.svg` |

| 线缆 | 文件名 |
|------|--------|
| 电力线 | `power-line.svg` |
| 制冷剂线 | `refrigerant-line.svg` |
| 水线 | `water-line.svg` |

| 总览 | 文件名 |
|------|--------|
| 全系统立体总览图 | `circuit-overview.svg` |

## 3. 视觉规范（必须严格遵守）

### 3.1 画布与视图

- `viewBox="0 0 200 200"`，`width="200" height="200"`，透明背景。
- 等轴视图（30° 倾角），物体正面朝向右上 45° 方向。
- 物体在画布中 **居中**，地面投影位于画布中下部 `y=170~185`。

### 3.2 颜色规范

| 用途 | 色值 | 说明 |
|------|------|------|
| 金属主体亮面 | `#D1D5DB` | linearGradient 高光端 |
| 金属主体暗面 | `#4B5563` | linearGradient 阴影端 |
| 金属侧边 | `#374151` | 侧面加深 |
| 地面投影 | `rgba(0,0,0,0.25)` | 软椭圆阴影 |
| 电力线 | `#E63946` | 红 |
| 制冷剂线 | `#2A9D8F` | 绿 |
| 水线 | `#1D6996` | 蓝 |
| 玻璃/电池片 | `#1E3A8A`（深蓝） | 光伏板 |
| 警示黄 | `#F59E0B` | 标注、标识 |
| 文字/标注 | `#111827` | 标签字 |
| 文字描边背景 | `#FFFFFF` `rx=2` | 标签白底 |

### 3.3 立体化通用技巧

1. **`<filter id="ds">`**：定义 `feDropShadow dx="2" dy="3" stdDeviation="2"`，所有部件主组应用此滤镜。
2. **`<linearGradient id="metalH">`**：从 `#D1D5DB` 到 `#4B5563`，模拟金属顶面受光。
3. **`<linearGradient id="metalV">`**：从 `#6B7280` 到 `#374151`，模拟金属侧面。
4. **`<radialGradient id="ledGlow">`**：从 `#FCD34D` 到 `#F59E0B`（透明度 0→1），用于指示灯。
5. 地面阴影：固定 `<ellipse cx="100" cy="180" rx="..." ry="6" fill="rgba(0,0,0,0.25)"/>`。
6. 等轴方向：X 向右 `(cos30°, sin30°)` ≈ `(0.866, 0.5)`；Y 向左 `(-0.866, 0.5)`；Z 向上 `(0, -1)`。
7. 部件 ID：`id` 属性以部件名拼音/英文命名（如 `id="pv-array"`），方便 React 引用。

### 3.4 标注样式

- 名称标签：底部白底圆角矩形 + 黑色文字，如 `<rect x="20" y="170" width="160" height="22" rx="4" fill="white"/><text x="100" y="186" text-anchor="middle" font-size="13" fill="#111827">光伏阵列</text>`。
- 关键参数：在标签中可附加参数占位，如 `5 kWp`、`SOC`。

## 4. 使用方式（阶段 1 前端）

```tsx
import PvArray from '@/base-elements/pv-array.svg?react';
import Inverter from '@/base-elements/inverter.svg?react';

<PvArray className="w-32 h-32" />
<Inverter className="w-32 h-32" />
```

或作为图片资源：

```html
<img src="/base-elements/heat-pump.svg" alt="热泵机组" />
```

## 5. 文件清单

**实际被 React 应用引用：15 个 SVG**

- 13 个部件：`pv-array` / `combiner-box` / `grid` / `grid-switch` / `inverter` / `battery` / `load` /
  `heat-pump` / `tank` / `pump` / `pcm` / `air-terminal` / `solar-air-cooler`
- 2 个仪表：`power-meter` / `temp-sensor`

**未被应用引用（保留作为视觉参考，删除前需确认无外部依赖）：**

- `power-line.svg` / `refrigerant-line.svg` / `water-line.svg` — 线缆早期实现，
  已被 `useParticleAnimation` 的 SVG `<circle>` 粒子方案取代；`src/` 内零引用
  （仅 `injector.ts:385` 的注释提到）
- `circuit-overview.svg` — 全系统总览参考图
- `index.html` — 旧版单文件演示页（已弃用，保留作 SVG 测试参考）

---

## 4. 跨平台与部署

**当前阶段**：通过 Vite dev server 访问 http://localhost:5173（`base-elements/` 由 `vite-svg-plugin` 在 dev 下服务，build 时由 `scripts/copy-svgs.mjs` 拷贝到 `dist/`）。

**可能的进一步交付方向**（尚未决策）：
- **桌面应用**：Tauri 2.0（构建产物是纯静态文件，技术上无障碍）
- **Web 部署**：Nginx 静态托管 / Vercel
- **移动端**：M1 不支持

**跨平台说明**：
- macOS 开发 → Windows 部署：构建产物是纯静态文件，跨平台兼容
- 桌面打包必须在目标平台构建（或用 CI/CD 跨平台构建）

---

## 6. 动画接入规范 ⭐（M1 核心新增）

> 本节定义 SVG 与动画层的 **接入契约**。SVG 通过 `data-animation-*` 属性声明可被动画层驱动的"钩子"；动画层读取仿真状态，调用 `injector.ts` 设置属性，CSS/JS 监听并播放对应动画。

### 6.1 属性命名约定

| 属性 | 用途 | 取值 |
|------|------|------|
| `data-animation-id` | 唯一动画钩子 ID（全局唯一，与 `数据字段映射.md` 中字段名对应） | 字符串，如 `pv_fan`、`bat_cell_group` |
| `data-animation-type` | 动画类型（决定 CSS/JS 行为） | 见 §6.2 |
| `data-animation-target` | 动画子节点选择器（用于批量驱动） | CSS 选择器，如 `[data-cell]` |
| `data-animation-bind` | 绑定的仿真字段（与 `SimulationState` 路径一致） | 字符串，如 `electrical.pvPowerKw` |
| `data-animation-range` | 数值映射区间（min,max），用于归一化 | `0,6` / `0,1` / `0,80` |
| `data-animation-mode` | 动画模式（speed / level / color / pulse / rotate） | 见 §6.2 |

### 6.2 动画类型清单

| `data-animation-type` | 含义 | 驱动方式 |
|----------------------|------|----------|
| `flow` | 流体粒子动画（电力/制冷剂/水） | 路由到 Canvas 粒子层（不在 SVG 内部） |
| `rotate` | 旋转动画（风扇/水泵/压缩机） | 设置 `transform: rotate(N deg)` + `animation-duration` |
| `pulse` | 脉冲动画（压缩机闪烁/异常描边） | 切换 CSS class（`pulse-on` / `pulse-off`） |
| `level` | 等级动画（电芯/LED 数量控制） | 注入器设置前 N 个子节点 fill |
| `color` | 颜色过渡（PCM/水箱/状态灯） | 注入器设置 fill / stop-color |
| `progress` | 进度条/功率条 | 注入器设置 width / height |
| `text` | 文本刷新（数字读数） | 注入器设置 textContent |
| `opacity` | 透明度（光束/LED 亮度） | 注入器设置 opacity |

### 6.3 注入器扩展接口

`injector.ts` 在现有 `injectFields / injectStatus / injectLevels` 基础上，新增 `injectAnimation`：

```ts
/**
 * 动画钩子注入：将 SimulationState 中的值映射到 SVG 钩子属性
 * - 数值类钩子：写入 data-animation-value（CSS 变量 [data-value] 读取）
 * - 状态类钩子：写入 data-animation-state（CSS 选择器匹配）
 */
function injectAnimation(
  svg: SVGElement,
  state: SimulationState
): void {
  // 1. 遍历所有 data-animation-id 节点
  // 2. 按 data-animation-bind 路径读取 state 值
  // 3. 归一化（除以 data-animation-range）
  // 4. 写入 data-animation-value / data-animation-state
}
```

### 6.4 CSS 变量绑定约定

动画层使用 CSS 变量传递驱动值，SVG 内部 CSS 通过 `attr()` / `var()` 消费：

```css
/* 示例：风扇旋转速度 */
[data-animation-type="rotate"][data-animation-bind*="powerKw"] {
  --anim-value: attr(data-animation-value number, 0);
  animation: rotate-fan 2s linear infinite;
  animation-duration: calc(4s - var(--anim-value) * 3s); /* 0→4s, 1→1s */
}
```

### 6.5 异常脉冲动画（CSS 兜底）

```css
@keyframes fault-pulse {
  0%, 100% { stroke: #EF4444; stroke-width: 2; }
  50%      { stroke: #FCA5A5; stroke-width: 4; }
}
[data-animation-state="error"] {
  stroke: #EF4444;
  animation: fault-pulse 1s ease-in-out infinite;
}
```

---

## 7. 部件动画钩子清单（M1 必填）

> 每个部件 SVG 至少声明以下钩子，动画层才能正确驱动。

### 7.1 通用约定

- `data-animation-id` 与 `数据字段映射.md` 中的字段名保持一致。
- 每个部件至少包含：`text`（数值刷新）+ 至少一种 `rotate/level/color` 内部动画。
- 部件外层 `<g id="...">` 必须包含 `data-component-id`，用于动画层按 ID 定位。

### 7.2 各部件钩子

| 部件 | 钩子 ID | 类型 | 绑定字段 | 备注 |
|------|---------|------|----------|------|
| 光伏阵列 | `pv_sun_beam` | opacity | `pv_sun_intensity` | 光束透明度 |
| 光伏阵列 | `pv_status_led` | pulse | `pv_status` | 状态灯（绿/灰/红） |
| 汇流箱 | `cb_led_1` ~ `cb_led_n` | level | `cb_pv_inputs` | 支路 LED |
| 双向逆变器 | `iv_pv_led` | pulse | `iv_pv` | PV 支路 LED |
| 双向逆变器 | `iv_bat_led` | pulse | `iv_bat` | BAT 支路 LED |
| 双向逆变器 | `iv_grid_led` | pulse | `iv_grid` | GRID 支路 LED |
| 双向逆变器 | `iv_load_led` | pulse | `iv_load` | LOAD 支路 LED |
| 双向逆变器 | `iv_power_bar` | progress | `electrical.ivPowerKw` | 功率条 |
| 蓄电池 | `bat_charge_level` | level | `battery.soc` | 10 节电芯 |
| 蓄电池 | `bat_flow` | flow | `battery.p` | 充放电流 |
| 蓄电池 | `bat_status_led` | pulse | `bat_status` | 状态灯 |
| 热泵机组 | `hp_fan` | rotate | `heatPump.powerKw` | 风扇旋转 |
| 热泵机组 | `hp_compressor` | pulse | `heatPump.mode` | 压缩机闪烁 |
| 热泵机组 | `hp_mode_color` | color | `heatPump.mode` | 模式色（蓝/橙/灰） |
| 水箱 | `tank_water_level` | color | `water.tankTempC` | 温度色 + 水位 |
| 循环水泵 | `pump_rotor` | rotate | `water.flowM3h` | 三角图标旋转 |
| 循环水泵 | `pump_status_led` | pulse | `water.pumpStatus` | 状态灯 |
| 相变材料 | `pcm_cells` | level + color | `pcm.tempC` + `pcm.phase` | 单元格色 + 充放 |
| 末端风盘 | `at_fan` | rotate | `terminals[i].fanSpeed` | 风扇旋转 |
| 末端风盘 | `at_air_flow` | flow | `terminals[i].fanSpeed` | 送风粒子方向 |
| 功率检测器 | `pm_value` | text | `electrical.*.powerKw` | 数字读数 |
| 功率检测器 | `pm_trend` | color | 趋势方向 | ▲/▼ 颜色 |
| 温度检测器 | `ts_value` | text + color | `*.*TempC` | 数字 + 颜色 |
| 电网 | `grid_led` | pulse | `gs_status` | 状态灯 |
| 并网开关 | `gs_state` | color | `gs_status` | 合闸/分闸色 |

### 7.3 总览图 `circuit-overview.svg`

总览图复用以上所有钩子，并增加：

- `ov_clock` — 文字刷新（仿真时间）
- `ov_pv_progress` / `ov_bat_soc` — 进度条
- `ov_*_bar` — 各类功率/温度条
- 异常高亮：`data-animation-state="error|warn"` 控制整图高亮

### 7.4 线缆 SVG 钩子

线缆 SVG 本身不渲染粒子（粒子在 Canvas 层），只声明路径信息：

```xml
<path id="power-pv-iv" data-line-kind="power" data-flow="pv-iv"
      data-from="pv-array" data-to="inverter"
      data-bind="electrical.pvPowerKw" data-range="0,6" />
```

动画层读取 `data-line-kind` / `data-bind` / `data-range`，在 Canvas 上对应位置生成粒子流。

---

## 8. 性能与可访问性约束

- SVG 内部动画优先用 CSS（GPU 合成），避免 JS 动画循环。
- `prefers-reduced-motion: reduce` 用户偏好下，禁用所有粒子动画与旋转动画，仅保留静态状态指示。
- 所有动画状态变更需保留 `aria-live` 提示（屏幕阅读器友好）：状态文字、温度、SOC 等关键值。
