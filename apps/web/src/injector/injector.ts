// SVG 数据注入器（TypeScript 版）
// 与 `base-elements/index.html` 的内联副本保持同步
// 关键约定：
//   - `data-field="xxx"` → 文本/状态注入（injectFields / injectStatus / injectLevels）
//   - `data-animation-id="xxx"` → 动画驱动字段注入（injectAnimations 写 CSS 变量或 HTML 属性）
//   - `data-clickable="true"` + `data-click-target="xxx"` → 点击交互（外部 attachClickHandlers）
// 关键修复：cache-buster、DOMParser、data-animation-id

import type { SimulationState } from '../store/simulation';
import { deriveInverterMode } from '../engine/schematicControl';

const svgCache = new Map<string, Promise<Document>>();

export function fetchSvg(path: string): Promise<Document> {
  if (!svgCache.has(path)) {
    const p = fetch(path + '?t=' + Date.now())
      .then((res) => {
        if (!res.ok) throw new Error(`SVG 加载失败 ${path}: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (!doc.documentElement || doc.querySelector('parsererror')) throw new Error(`SVG 解析失败: ${path}`);
        return doc;
      });
    svgCache.set(path, p);
    // 失败 Promise 不能永久占据缓存；下次渲染/重挂载应有机会重新请求。
    void p.catch(() => {
      if (svgCache.get(path) === p) svgCache.delete(path);
    });
  }
  return svgCache.get(path)!;
}

/**
 * 文本字段注入：`data-field="xxx"` 匹配 → textContent 替换
 * fields 形如 { pv_power: '3.24 kW', bat_soc: '78%', ... }
 */
/**
 * 一次遍历建立 data-field → 节点 的索引，再按需写入。
 *
 * 原实现对每个 key 各做一次 querySelectorAll，buildInjectData 产出约 120 个 key，
 * 19 个插槽每次状态变更就是约 2280 次选择器查询。改成单次 querySelectorAll
 * 建 Map，复杂度从 O(keys × DOM) 降到 O(DOM + keys)。
 */
export function injectFields(svg: SVGElement, fields: Record<string, string>) {
  const index = new Map<string, HTMLElement[]>();
  svg.querySelectorAll<HTMLElement>('[data-field]').forEach((node) => {
    const key = node.getAttribute('data-field');
    if (!key) return;
    const bucket = index.get(key);
    if (bucket) bucket.push(node);
    else index.set(key, [node]);
  });
  Object.entries(fields).forEach(([key, value]) => {
    const nodes = index.get(key);
    if (!nodes) return;
    for (const node of nodes) {
      if (node.tagName === 'text' || node.tagName === 'tspan') {
        node.textContent = String(value);
      }
    }
  });
}

/**
 * LED 状态注入：key 已是 SVG 里的**完整 data-field 名**（不再追加 `_led` 后缀）。
 * 之所以这么改：SVG 里 LED 命名不统一（bat_status_led / cb_led / gs_led_on / grid_offline_led），
 * 用完整路径最不容易出错。
 *
 * status 形如：
 *   { "bat_status_led": "#22C55E", "cb_led": "#22C55E", "gs_led_on": "#22C55E", "grid_offline_led": "#9CA3AF" }
 */
export function injectStatus(svg: SVGElement, status: Record<string, string>) {
  Object.entries(status).forEach(([key, color]) => {
    if (!color) return;
    const led = svg.querySelector<HTMLElement>(`[data-field="${key}"]`);
    if (led) led.setAttribute('fill', color);
  });
}

/**
 * 状态文字色（status_text 字段）注入
 * statusText 形如 { "hp_status_text": "#22C55E", "at_status_text": "#0EA5E9" }
 */
export function injectStatusText(svg: SVGElement, statusText: Record<string, string>) {
  Object.entries(statusText).forEach(([key, color]) => {
    if (!color) return;
    const text = svg.querySelector<HTMLElement>(`[data-field="${key}"]`);
    if (text) text.setAttribute('fill', color);
  });
}

/**
 * 等级条/电芯格子注入：data-field="xxx" 容器内所有 [data-cell] 元素按 idx 染色
 * levels 形如 { bat_charge_level: 7 }（0~10）
 */
export function injectLevels(svg: SVGElement, levels: Record<string, number>) {
  Object.entries(levels).forEach(([key, value]) => {
    const group = svg.querySelector<HTMLElement>(`[data-field="${key}"]`);
    if (!group) return;
    const max = value > 10 ? 10 : value;
    const cells = group.querySelectorAll<HTMLElement>('[data-cell]');
    cells.forEach((cell, idx) => {
      if (idx < max) {
        cell.setAttribute('fill', 'url(#btCell)');
        cell.setAttribute('opacity', '1');
      } else {
        cell.setAttribute('fill', 'url(#btCellE)');
        cell.setAttribute('opacity', '0.7');
      }
    });
  });
}

/**
 * 几何注入：通过 [data-field="<key>"] 匹配，写入位置 / 尺寸属性（width/height/x/y/cx/cy）
 *
 * 适用场景（v23 新增 4 字段）：
 *   - bat_progress_bar：<rect>，width = bat_soc/100 * 140
 *   - load_power_bar：<rect>，width = clamp(0..100, iv_power/10 * 100)
 *   - gs_handle_ball：<circle>，fill 由 gs_on 决定（绿=合闸/红=分闸）
 *
 * 注意：ts_mercury 不通过此函数注入 — temp-sensor.svg 内 .anim-ts-mercury 的 height/transform
 * 已由 CSS `var(--anim-ts-temp)` 驱动（injectAnimations 的 ts_anim_temp 通道）。
 * 若再通过 geometry 写 width/height/y 会与 CSS 冲突，反而破坏动画。
 *
 * geometry 形如：
 *   {
 *     bat_progress_bar: { width: 109 },         // 仅设 width（presentation attribute）
 *     load_power_bar:   { width: 62 },          // 仅设 width
 *     gs_handle_ball:   { fill: '#22C55E' },    // 圆 fill 颜色（用 inline style 覆盖 CSS 优先级）
 *   }
 *
 * 设计取舍：fill 字段用 inline style (style.fill) 而非 setAttribute('fill')，
 * 因 SVG CSS 优先级规则 `.anim-handle-ball { fill: var(...) }` 会覆盖 presentation attribute。
 */
export interface GeometryPatch {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  fill?: string;
}

export function injectGeometry(
  svg: SVGElement,
  geometry: Record<string, GeometryPatch>
) {
  Object.entries(geometry).forEach(([key, patch]) => {
    const node = svg.querySelector<HTMLElement>(`[data-field="${key}"]`);
    if (!node) return;
    if (patch.width != null)  node.setAttribute('width',  String(patch.width));
    if (patch.height != null) node.setAttribute('height', String(patch.height));
    if (patch.x != null)      node.setAttribute('x',      String(patch.x));
    if (patch.y != null)      node.setAttribute('y',      String(patch.y));
    if (patch.cx != null)     node.setAttribute('cx',     String(patch.cx));
    if (patch.cy != null)     node.setAttribute('cy',     String(patch.cy));
    // fill 用 inline style（优先级最高，能覆盖 .anim-handle-ball { fill: var(...) }）
    if (patch.fill != null)   (node as unknown as HTMLElement).style.fill = String(patch.fill);
  });
}

/**
 * 动画驱动字段注入：通过 [data-animation-id] 匹配，把值写入 CSS 变量或 HTML 属性
 * 关键：SVG 必须有对应 [data-animation-id]，否则字段静默丢失（不报错）
 *
 * v23 animations 形如：
 *   {
 *     pv_anim_sun_speed: 0.6,      // 写入 --anim-sun-duration（PV 太阳轨道速度）
 *     hp_anim_fan: 3.0,            // 写入 --anim-fan-duration（匹配 SVG hp_anim_fan）
 *     pump_anim_impeller: 2.0,     // 写入 --anim-impeller-duration（匹配 SVG pump_anim_impeller）
 *     at_anim_fan_speed: 2,        // 写入 --anim-fan-duration（匹配 SVG at_anim_fan_speed）
 *     pcm_anim_melt: 0.56,         // 写入 --pcm-melt + --pcm-piece-color + --pcm-bubble-vis
 *     pcm_anim_transition: 4.0,    // 写入 --pcm-transition
 *     ts_anim_temp: 0.33,          // 写入 --anim-ts-temp + data-ts-temp（驱动 SVG .anim-ts-mercury + .anim-ts-pointer）
 *     tank_anim_water_fill: 0.65,  // 写入 --anim-water-norm
 *     tank_anim_temp_color: 'hsl(...)',  // 写入 --anim-temp-color
 *     bat_anim_flow_dir: 'in',     // 写入 data-anim-flow-dir
 *     soc_low: false,              // 写到根 data-component-id（特殊：SVG 无 data-animation-id="soc_low" 元素）
 *   }
 *
 * v23 清理：移除 pv_anim_sun_x/y、tank_anim_flow_speed；重命名 hp_anim_fan_speed→hp_anim_fan、pump_anim_impeller_speed→pump_anim_impeller。
 * M1.5 Round 8：恢复 tank_anim_flow_speed（SVG .anim-flow-bubble CSS 改用 var(--anim-bubble-duration)）。
 */
export function injectAnimations(svg: SVGElement, animations: Record<string, any>) {
  Object.entries(animations).forEach(([key, value]) => {
    const nodes = svg.querySelectorAll<HTMLElement>(`[data-animation-id="${key}"]`);
    const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;

    nodes.forEach((node) => {
      node.setAttribute('data-animation-value', String(value));

      // 太阳速度（决定 CSS keyframe 周期）— SVG ID 为 pv_anim_sun_speed
      if (key === 'pv_anim_sun_speed') {
        const dur = Math.max(2, 12 - num * 10);
        node.style.setProperty('--anim-sun-duration', `${dur}s`);
      }
      // 并网开关手柄球颜色（demo.html 模式：CSS 变量路径，与 geometry.fill 互不冲突）
      else if (key === 'gs_anim_handle_color') {
        node.style.setProperty('--anim-handle-color', String(value));
      }
      // 光伏板反光扫动周期（SVG 端 6 块板 animation-delay 错开 0~2.5s）— 当前 SVG 无 data-animation-id 节点，静默 no-op
      else if (key === 'pv_anim_panel_speed') {
        const dur = Math.max(2, 5 - num * 3);
        node.style.setProperty('--anim-panel-duration', `${dur}s`);
      }
      // 热泵风扇（SVG ID 为 hp_anim_fan）→ --anim-fan-duration
      else if (key === 'hp_anim_fan') {
        // L4 渐近公式：dur = max(0.3, 0.3 + 2.7/(1 + n/2))
        // hp_power 0→3.0s, 1→2.06s, 2→1.5s, 3.5→1.13s, 5→0.90s, 8→0.68s
        // 永不饱和，全程平滑变化
        const dur = num > 0 ? Math.max(0.3, 0.3 + 2.7 / (1 + num / 2)) : 0;
        node.style.setProperty('--anim-fan-duration', `${dur}s`);
      }
      // 水泵叶轮（SVG ID 为 pump_anim_impeller）→ --anim-impeller-duration
      else if (key === 'pump_anim_impeller') {
        const dur = num > 0 ? Math.max(0.3, 2.5 - num * 2) : 0;
        node.style.setProperty('--anim-impeller-duration', `${dur}s`);
        // ★ M1.5 Round 9：同步写到 .anim-motor-fan + .anim-coupling（共享泵旋转速度）
        // pump.svg 中这三个旋转部件 CSS 都消费 --anim-impeller-duration
        // 但只有 .anim-impeller 有 data-animation-id，因此变量被钳制在单个节点
        const fanNodes = svg.querySelectorAll<HTMLElement>('.anim-motor-fan, .anim-coupling, .anim-impeller');
        fanNodes.forEach(n => n.style.setProperty('--anim-impeller-duration', `${dur}s`));
      }
      // 末端风盘风扇（SVG ID 为 at_anim_fan_speed）→ --anim-fan-duration
      else if (key === 'at_anim_fan_speed') {
        const dur = num > 0 ? Math.max(0.5, 2.5 - num * 0.6) : 0;
        node.style.setProperty('--anim-fan-duration', `${dur}s`);
        // ★ M1.5 Round 9：归一化 0..1 写给 louvers + 4 档 LED（demo.html:444 模式）
        const norm = Math.max(0, Math.min(1, num / 4));
        node.style.setProperty('--anim-fan-speed-norm', String(norm));
        // ★ 同时写到 at_anim_fan 节点（旋转风扇线圈），因 CSS 变量不跨兄弟节点继承
        svg.querySelectorAll<HTMLElement>('[data-animation-id="at_anim_fan"]').forEach(fanNode => {
          fanNode.style.setProperty('--anim-fan-duration', `${dur}s`);
        });
      }
      // A2: 末端风盘出风粒子速度（SVG ID at_anim_air_flow）→ --anim-air-speed
      // air-terminal.svg 行 57 已消费 var(--anim-air-speed, 1s)；fan_speed 通道
      // 写的是 --anim-fan-duration（叶片旋转速度），不能复用到粒子线性位移
      else if (key === 'at_anim_air_flow') {
        const dur = num > 0 ? Math.max(0.5, 2.5 - num * 0.6) : 0;
        node.style.setProperty('--anim-air-speed', `${dur}s`);
      }
      // 太阳能水冷风扇：内置风机、冷风、水泵与水箱独立动画
      else if (key === 'sac_anim_fan_speed') {
        const dur = num > 0 ? Math.max(0.4, 2.6 - num * 2.1) : 0;
        node.style.setProperty('--anim-fan-duration', `${dur}s`);
      }
      else if (key === 'sac_anim_air_flow') {
        const dur = num > 0 ? Math.max(0.4, 2.1 - num * 1.5) : 0;
        node.style.setProperty('--anim-air-speed', `${dur}s`);
      }
      else if (key === 'sac_anim_pump_flow') {
        const dur = num > 0 ? Math.max(0.35, 2.2 - num * 1.7) : 0;
        node.style.setProperty('--anim-impeller-duration', `${dur}s`);
      }
      else if (key === 'sac_anim_water_fill') {
        node.style.setProperty('--anim-water-norm', String(Math.max(0, Math.min(1, num))));
      }
      else if (key === 'sac_anim_water_color') {
        node.style.setProperty('--anim-water-color', String(value));
      }
      // A3: 汇流箱 PV 输入 LED 亮数（SVG ID cb_anim_pv_inputs）→ --anim-pv-inputs
      // combiner-box.svg 行 89-92 已消费 var(--anim-pv-inputs, 4)，4 路 LED 按 0~1 阶梯点亮
      else if (key === 'cb_anim_pv_inputs') {
        const norm = Math.max(0, Math.min(1, num / 4));
        node.style.setProperty('--anim-pv-inputs', String(norm));
      }
      // 水箱水量填充
      else if (key === 'tank_anim_water_fill') {
        const norm = Math.max(0, Math.min(1, num));
        node.style.setProperty('--anim-water-norm', String(norm));
      }
      // 水箱温度色
      else if (key === 'tank_anim_temp_color') {
        node.style.setProperty('--anim-temp-color', String(value));
        // ★ M1.5 Round 9 修复：水箱温度颜色同步到水色（tank.svg:166 data-animation-id-color 钩子）
        const colorTargets = svg.querySelectorAll<HTMLElement>(`[data-animation-id-color="${key}"]`);
        colorTargets.forEach(t => t.style.setProperty('--anim-water-color', String(value)));
      }
      // 水箱气泡流速 → --anim-bubble-duration（higher flow = faster bubbles = shorter duration）
      else if (key === 'tank_anim_flow_speed') {
        const dur = num > 0 ? Math.max(0.5, 3 - num * 0.5) : 0;
        node.style.setProperty('--anim-bubble-duration', `${dur}s`);
      }
      // PCM 融化比例（v19：恢复 v16 CSS 变量驱动，与全代码库 13 个非 PCM 部件模式一致）
      else if (key === 'pcm_anim_melt') {
        const norm = Math.max(0, Math.min(1, num));
        // 1. 主变量（SVG 端 6 个 hex 用 calc((var(--pcm-melt) - var(--lo)) * 6) 自动算 --m）
        node.style.setProperty('--pcm-melt', String(norm));
        // 2. 色带：深蓝→中蓝→浅蓝→水白（v21 物理直觉：冰→水）
        const stops: Array<[number, number, number, number]> = [
          [0.00, 0x1E, 0x40, 0xAF], // #1E40AF 深蓝（冷态）
          [0.20, 0x3B, 0x82, 0xF6], // #3B82F6 中蓝
          [0.45, 0x60, 0xA5, 0xFA], // #60A5FA 中浅蓝
          [0.65, 0x93, 0xC5, 0xFD], // #93C5FD 浅蓝
          [0.85, 0xBF, 0xDB, 0xFE], // #BFDBFE 很浅蓝
          [1.00, 0xE0, 0xF2, 0xFE], // #E0F2FE 接近水
        ];
        let i = 0;
        for (; i < stops.length - 1; i++) {
          if (norm >= stops[i][0] && norm <= stops[i + 1][0]) break;
        }
        const [t1, r1, g1, b1] = stops[i];
        const [t2, r2, g2, b2] = stops[Math.min(i + 1, stops.length - 1)];
        const range = t2 - t1 || 1;
        const k = (norm - t1) / range;
        const r = Math.round(r1 + (r2 - r1) * k);
        const g = Math.round(g1 + (g2 - g1) * k);
        const b = Math.round(b1 + (b2 - b1) * k);
        node.style.setProperty('--pcm-piece-color', `rgb(${r}, ${g}, ${b})`);
        // 3. 气泡可见度（v21 阶梯：melt >= 0.3 开始出现，0.3~0.7 渐入）
        const bubbleVis = norm < 0.3 ? 0 : Math.max(0, Math.min(1, (norm - 0.3) / 0.4));
        node.style.setProperty('--pcm-bubble-vis', String(bubbleVis));
        // ⭐ 不再写 --pcm-cell-color 和 --pcm-liquid-h（液面用 url(#pcmHot) 渐变 + CSS clamp 阶梯）
        // ⭐ 不再 querySelector 子元素、不再写 poly.style.transform / poly.style.opacity
      }
      // PCM 相变过渡时长（秒）→ --pcm-transition
      else if (key === 'pcm_anim_transition') {
        node.style.setProperty('--pcm-transition', `${Math.max(0.3, num)}s`);
      }
      // 温度传感器水银柱高度 + 指针旋转（SVG 内 .anim-ts-mercury / .anim-ts-pointer 都消费 var(--anim-ts-temp)）
      else if (key === 'ts_anim_temp') {
        const norm = Math.max(0, Math.min(1, num));
        node.style.setProperty('--anim-ts-temp', String(norm));
        node.setAttribute('data-ts-temp', String(norm));
      }
      // 蓄电池流向
      else if (key === 'bat_anim_flow_dir') {
        node.setAttribute('data-anim-flow-dir', String(value));
      }
      // 功率表脉冲 LED 闪烁速度（PM 圆盘 3 功率 → 越大闪越快）
      else if (key === 'pm_pulse_speed') {
        const dur = num > 0 ? Math.max(0.15, 0.6 - num * 0.1) : 0;
        node.style.setProperty('--anim-pulse-duration', `${dur}s`);
      }
    });
  });

  // 蓄电池低 SOC：写到根 data-component-id（SVG 没 data-animation-id="soc_low" 元素，
  // CSS 选择器 [data-anim-soc-low="true"] 在 battery.svg 直接挂在根）
  if (animations.soc_low != null) {
    const root = svg.querySelector<HTMLElement>('[data-component-id]');
    if (root) root.setAttribute('data-anim-soc-low', String(animations.soc_low));
  }
}

/**
 * 部件整体动画状态写入根 `<g data-component-id>`；未列入 DIRECT_ATTRS 的键使用 `data-anim-${key}-state`。
 * animStates 形如 { refrigerant: 'cool', fan: 'on', impeller: 'off' }
 */
const DIRECT_ATTRS: Record<string, string> = {
  'iv-mode': 'data-anim-iv-mode',
  'pump-running': 'data-anim-pump-running',
  'grid-state': 'data-anim-grid-state',
  'load-state': 'data-load-state',
  'hp-mode': 'data-hp-mode',
};

export function injectAnimStates(svg: SVGElement, animStates: Record<string, string>) {
  const root = svg.querySelector<HTMLElement>('[data-component-id]');
  if (!root) return;

  Object.entries(animStates).forEach(([key, value]) => {
    root.setAttribute(DIRECT_ATTRS[key] ?? `data-anim-${key}-state`, value);
  });
}

/**
 * 部件根属性映射表：data-component-id → { 属性名: 取值函数 }
 *
 * 与 injectAnimStates 的区别：injectAnimStates 接收通用键值字典（向后兼容），由 buildInjectData 集中拼装；
 * injectComponentRootState 则按部件类型 dispatch 到不同的根属性，避免 buildInjectData 里写一堆条件分支。
 *
 * 11 固定部件 + pcm 由 injectAnimStates 处理（phase 键）：
 *   - pv-array/combiner-box/grid/grid-switch/battery/pump/air-terminal：单一 data-anim-state
 *   - inverter：data-anim-state（顶部风扇）+ data-anim-iv-mode（箭头方向）
 *   - heat-pump：data-anim-state（风扇/压缩机/活塞）+ data-hp-mode（制冷剂流向）
 *   - load：data-anim-state + data-load-state
 *   - tank：data-anim-pump-running（唯一非 data-anim-state 的）
 *
 * 注意：电源线缆（power-line/refrigerant-line/water-line）通过 useParticleAnimation 的 Canvas 粒子渲染，
 *       不注入 SVG。仪表卡（power-meter/temp-sensor）没有 data-anim-* 状态，本函数对它们是 no-op。
 */
type StateAttrFn = (state: SimulationState) => string;
type RootAttrMap = Record<string, StateAttrFn>;

function replayFlag(state: SimulationState, key: 'pv_on' | 'cb_connected' | 'gs_on' | 'grid_online' | 'hp_on' | 'pump_on' | 'load_on'): boolean {
  // 回放未提供状态时沿用场景状态；“未知”不能被伪装成明确关闭。
  return state[key];
}

function replayAtMode(state: SimulationState): SimulationState['at_mode'] {
  return state.at_mode;
}

function replayInverterMode(state: SimulationState) {
  return deriveInverterMode({
    ...state,
    pv_on: replayFlag(state, 'pv_on'),
    cb_connected: replayFlag(state, 'cb_connected'),
    grid_online: replayFlag(state, 'grid_online'),
    gs_on: replayFlag(state, 'gs_on'),
  });
}

const COMPONENT_ROOT_STATES: Record<string, RootAttrMap> = {
  'pv-array': {
    'data-anim-state': (s) => (s.controlMode === 'replay'
      ? replayFlag(s, 'pv_on')
      : s.pv_on || s.pv_power > 0.01) ? 'on' : 'off',
  },
  'combiner-box': {
    'data-anim-state': (s) => replayFlag(s, 'cb_connected') ? 'connected' : 'disconnected',
  },
  'grid': {
    // Fix B3：grid_online 独立驱动（不再恒定 on-grid；M2 引擎可独立驱动 gridPowerKw）
    'data-anim-grid-state': (s) => replayFlag(s, 'grid_online') ? 'on-grid' : 'offline',
  },
  'grid-switch': {
    'data-anim-state': (s) => replayFlag(s, 'gs_on') ? 'on' : 'off',
  },
  'inverter': {
    'data-anim-state': (s) => replayInverterMode(s) === 'idle' ? 'off' : 'on',
    'data-anim-iv-mode': replayInverterMode,
  },
  'battery': {
    'data-anim-state': (s) => s.bat_soc > 0 ? 'on' : 'off',
  },
  'load': {
    'data-anim-state': (s) => replayFlag(s, 'load_on') ? 'on' : 'off',
    'data-load-state': (s) => replayFlag(s, 'load_on') ? 'on' : 'off',
  },
  'heat-pump': {
    // A1: hp_on 为 false 时把 data-anim-state 强制写成 'off'，HP 内 .anim-fan / .anim-compressor /
    // .anim-piston / .anim-refrigerant-flow / .anim-hp-water 全部 CSS 规则只匹配
    // 'on'/'cool'/'heat'，匹配不到 → 动画静态 + opacity 保持 0。
    'data-anim-state': (s) => replayFlag(s, 'hp_on') ? replayAtMode(s) : 'off',
    'data-hp-mode': replayAtMode,
    'data-hp-on': (s) => replayFlag(s, 'hp_on') ? 'true' : 'false',
  },
  'tank': {
    'data-anim-pump-running': (s) => replayFlag(s, 'pump_on') ? 'true' : 'false',
  },
  'pump': {
    'data-anim-state': (s) => replayFlag(s, 'pump_on') ? 'on' : 'off',
  },
  'air-terminal': {
    'data-anim-state': replayAtMode,
    'data-anim-fan-running': (s) => replayAtMode(s) !== 'off' && s.at_fan_speed > 0 ? 'true' : 'false',
  },
  'solar-air-cooler': {
    'data-anim-state': (s) => s.sac_on ? (s.sac_water_level <= 10 ? 'low-water' : 'on') : 'off',
  },
};

/**
 * pcm 的 data-anim-phase-state 由 injectAnimStates 的 'phase' 键写入（走默认规则 data-anim-phase-state），
 * 因为相态需要 derivePcmVisual(state) 计算（不是简单 flag 派生），保留在 buildInjectData.animStates.phase 通道。
 */

/**
 * 按 componentId dispatch，写入对应的根属性。
 * 找不到映射（如 power-meter/temp-sensor）→ no-op。
 */
export function injectComponentRootState(
  svg: SVGElement,
  state: SimulationState,
  componentId: string,
) {
  const root = svg.querySelector<HTMLElement>('[data-component-id]');
  const map = COMPONENT_ROOT_STATES[componentId];
  if (!map) return;
  Object.entries(map).forEach(([attr, fn]) => {
    const value = fn(state);
    // 同时写外层 React SVG 和素材内部根节点。grid 的输电线位于内部根节点之外，
    // 只有外层属性才能作为其 CSS 状态祖先；其它部件保持原内部根属性兼容。
    svg.setAttribute(attr, value);
    root?.setAttribute(attr, value);
  });
}

/**
 * 一键注入所有数据。
 *
 * opts:
 *   - fields:     文本字段（数字读数、容量等）
 *   - status:     LED 颜色（key 是 SVG 完整 data-field 名）
 *   - statusText: 状态文字色（key 是 SVG 完整 data-field 名）
 *   - levels:     等级条/电芯格子（0~10）
 *   - animations: 动画驱动字段（key 对应 data-animation-id）
 *   - geometry:   几何/尺寸字段（width/height/x/y/cx/cy/fill）
 *   - animStates: 部件整体状态（写入根 data-component-id 的 data-anim-*-state 属性）
 */
export function injectAll(
  svg: SVGElement,
  opts: {
    fields?: Record<string, string>;
    status?: Record<string, string>;
    statusText?: Record<string, string>;
    levels?: Record<string, number>;
    animations?: Record<string, any>;
    geometry?: Record<string, GeometryPatch>;
    animStates?: Record<string, string>;
  }
) {
  if (opts.fields) injectFields(svg, opts.fields);
  if (opts.status) injectStatus(svg, opts.status);
  if (opts.statusText) injectStatusText(svg, opts.statusText);
  if (opts.levels) injectLevels(svg, opts.levels);
  if (opts.animations) injectAnimations(svg, opts.animations);
  if (opts.geometry) injectGeometry(svg, opts.geometry);
  if (opts.animStates) injectAnimStates(svg, opts.animStates);
}
