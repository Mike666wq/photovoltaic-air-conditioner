/**
 * base-elements SVG 数据注入器 v2
 *
 * 用法：
 *   import { loadAndInject, attachClickHandlers, updateAnimation } from './injector';
 *   await loadAndInject('pv-array.svg', mountEl, {
 *     pv_power: '3.24 kW',
 *     pv_progress: '64%',
 *     pv_status: 'running',
 *     pv_sun_intensity: 0.6,
 *   });
 *   attachClickHandlers(mountEl, {
 *     'heat-pump': (state) => { state.hp_fan = state.hp_fan === 'on' ? 'off' : 'on'; },
 *   });
 *
 * M2 新增字段支持（M2 数据接入，详见 数据字段映射.md §2.4-§2.5）：
 *   - hp_outlet_temp / hp_outlet_temp_anim  （热泵出风温度/色，T2_PV）
 *   - tank_supply_temp / tank_supply_temp_anim  （水箱进水温度/色，T4_PV）
 *   - tank_return_temp / tank_return_temp_anim  （水箱回水温度/色，T5_PV）
 *   - grid_voltage / mains_voltage / dc_voltage  （三处电压值）
 *   - grid_current / mains_current / dc_current  （三处电流值）
 *   - battery_alarm / battery_protection / battery_balance  （电池文字标签，不触发任何动画）
 *
 * 配套：
 *   - 数据字段映射.md（字段定义 + 动画驱动字段）
 *   - demo.html（演示页面 + 点击交互）
 *   - 数据读入.md（M2 数据接入规范）
 *   - 仿真引擎契约.md §3（SimulationState 权威定义）
 */

export type FieldValue = string | number;
export type StatusValue =
  | 'running' | 'standby' | 'fault'
  | 'cool' | 'heat' | 'idle' | 'off'
  | 'charging' | 'discharging'
  | 'on' | 'warn' | 'connected' | 'disconnected';

export interface InjectOptions {
  // 文本字段
  fields?: Record<string, FieldValue>;
  // 状态字段（影响 LED 颜色 + 文字）
  status?: Record<string, StatusValue>;
  // 等级字段（数字 0-max，电芯/LED 数量控制）
  levels?: Record<string, number>;
  // 动画驱动字段（设置 data-animation-value / CSS 变量）
  animations?: Record<string, FieldValue>;
  // 动画状态字段（设置 data-anim-state 等属性）
  animStates?: Record<string, string>;
}

/** SVG 渐变 / 颜色映射表（用于状态切换） */
const STATUS_COLORS: Record<StatusValue, { fill: string; glow: string; text: string }> = {
  running:  { fill: 'url(#ledG)',  glow: 'url(#ledGlow)',  text: '#22C55E' },
  standby:  { fill: '#9CA3AF',      glow: 'none',            text: '#9CA3AF' },
  fault:    { fill: 'url(#ledR)',   glow: 'none',            text: '#EF4444' },
  cool:     { fill: 'url(#ledB)',   glow: 'url(#ledGlB)',    text: '#0EA5E9' },
  heat:     { fill: 'url(#ledO)',   glow: 'url(#ledGlO)',    text: '#F97316' },
  idle:     { fill: '#9CA3AF',      glow: 'none',            text: '#9CA3AF' },
  off:      { fill: '#374151',      glow: 'none',            text: '#6B7280' },
  charging: { fill: 'url(#ledG)',   glow: 'url(#ledGlow)',   text: '#22C55E' },
  discharging: { fill: 'url(#ledB)', glow: 'url(#ledGlB)',   text: '#0EA5E9' },
  on:       { fill: 'url(#ledG)',   glow: 'url(#ledGlow)',   text: '#22C55E' },
  warn:     { fill: 'url(#ledY)',   glow: 'none',            text: '#EAB308' },
  connected:    { fill: 'url(#ledG)', glow: 'url(#ledGlow)', text: '#22C55E' },
  disconnected: { fill: '#9CA3AF',    glow: 'none',           text: '#9CA3AF' },
};

/** 1. 注入文本字段 */
export function injectFields(svg: SVGElement, fields: Record<string, FieldValue>): void {
  Object.entries(fields).forEach(([key, value]) => {
    const nodes = svg.querySelectorAll(`[data-field="${key}"]`);
    nodes.forEach(node => {
      const tag = node.tagName.toLowerCase();
      if (key.endsWith('_intensity') && typeof value === 'number') {
        node.setAttribute('opacity', String(value));
      } else if (tag === 'text' || tag === 'tspan') {
        node.textContent = String(value);
      } else if (tag === 'circle' || tag === 'rect') {
        node.setAttribute('fill', String(value));
      } else {
        node.textContent = String(value);
      }
    });
  });
}

/** 2. 注入状态字段 */
export function injectStatus(svg: SVGElement, status: Record<string, StatusValue>): void {
  Object.entries(status).forEach(([key, val]) => {
    const color = STATUS_COLORS[val];
    if (!color) return;
    const led = svg.querySelector(`[data-field="${key}_led"]`);
    if (led) led.setAttribute('fill', color.fill);
    const glow = svg.querySelector(`[data-field="${key}_glow"]`);
    if (glow) {
      glow.setAttribute('fill', color.glow);
      glow.setAttribute('opacity', val === 'fault' || val === 'off' || val === 'idle' || val === 'standby' || val === 'disconnected' ? '0' : '1');
    }
    const textNode = svg.querySelector(`[data-field="${key}_status_text"]`);
    if (textNode) textNode.setAttribute('fill', color.text);
  });
}

/** 3. 注入等级字段 */
export function injectLevels(svg: SVGElement, levels: Record<string, number>): void {
  Object.entries(levels).forEach(([key, value]) => {
    const group = svg.querySelector(`[data-field="${key}"]`);
    if (!group) return;
    const max = value > 10 ? 10 : value;
    const cells = group.querySelectorAll('[data-cell]');
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

/** 4. 注入动画驱动字段（设置 data-animation-value + CSS 变量） */
export function injectAnimations(svg: SVGElement, animations: Record<string, FieldValue>): void {
  const root = svg.querySelector('[data-component-id]') as HTMLElement | null;
  Object.entries(animations).forEach(([key, value]) => {
    // 设置到所有匹配 data-animation-id 的元素
    const nodes = svg.querySelectorAll(`[data-animation-id="${key}"]`);
    nodes.forEach(node => {
      node.setAttribute('data-animation-value', String(value));

      // 根据 key 前缀映射到 CSS 变量
      if (key.includes('fan')) {
        // 风扇速度 → duration（值越大转得越快，duration 越短）
        // 默认 speed=1 时 duration=1.5s；speed=0.2 时 duration=3s
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
        const dur = Math.max(0.3, 3 - num * 2.5);
        (node as HTMLElement).style.setProperty('--anim-fan-duration', `${dur}s`);
        (node as HTMLElement).style.setProperty('--anim-impeller-duration', `${dur * 0.7}s`);
      } else if (key.includes('impeller')) {
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
        const dur = Math.max(0.3, 2.5 - num * 2);
        (node as HTMLElement).style.setProperty('--anim-impeller-duration', `${dur}s`);
      } else if (key === 'sac_anim_pump_flow') {
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
        const dur = Math.max(0.35, 2.2 - num * 1.7);
        (node as HTMLElement).style.setProperty('--anim-impeller-duration', `${dur}s`);
      } else if (key.includes('sun')) {
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
        const dur = Math.max(2, 12 - num * 10);
        (node as HTMLElement).style.setProperty('--anim-sun-duration', `${dur}s`);
      } else if (key.includes('panel')) {
        // 板面反光扫动 duration（v0.3.1 新增，见 部件动画增强.md §2.3）
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
        const dur = Math.max(2, 5 - num * 3);
        (node as HTMLElement).style.setProperty('--anim-panel-duration', `${dur}s`);
      } else if (key === 'at_anim_fan_speed') {
        // 末端风盘 4 档离散映射（v0.3.1 新增，见 部件动画增强.md §8.4）
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        const speedTable: Record<number, number> = { 0: 0, 1: 2, 2: 1.2, 3: 0.6 };
        const dur = speedTable[num] ?? 1.5;
        (node as HTMLElement).style.setProperty('--anim-fan-duration', `${dur}s`);
        // 进风格栅亮度（0~1 归一化）
        (node as HTMLElement).style.setProperty('--anim-fan-speed-norm', String(num / 3));
        if (dur === 0) {
          (node as HTMLElement).style.setProperty('--anim-fan-running', '0');
        } else {
          (node as HTMLElement).style.setProperty('--anim-fan-running', '1');
        }
      } else if (key.includes('air')) {
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
        const dur = Math.max(0.4, 2 - num * 1.5);
        (node as HTMLElement).style.setProperty('--anim-air-speed', `${dur}s`);
      } else if (key.includes('water_fill')) {
        // 水箱水位 + 水温色（共用一个 animation-id）
        // v0.3.2: 改用 --anim-water-norm（0~1），SVG 端用 transform: translateY() 渲染
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        const norm = Math.max(0, Math.min(1, num));
        (node as HTMLElement).style.setProperty('--anim-water-norm', String(norm));
        // 保留旧 CSS 变量以兼容
        const y = 200 - norm * 120;
        (node as HTMLElement).style.setProperty('--anim-water-y', `${y}px`);
        const height = norm * 120;
        (node as HTMLElement).style.setProperty('--anim-water-height', `${height}px`);
      } else if (key === 'pv_anim_sun_x' || key === 'pv_anim_sun_y') {
        // v0.3.2 fix: broadcast to component root so all sibling nodes inherit
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        const prop = `--anim-${key.replace('pv_anim_', '')}`;
        (node as HTMLElement).style.setProperty(prop, `${num}px`);
        if (root) root.style.setProperty(prop, `${num}px`);
        if (root && key === 'pv_anim_sun_x') {
          let pos = 'center';
          if (num < 80) pos = 'left';
          else if (num > 160) pos = 'right';
          root.setAttribute('data-anim-sun-x', pos);
        }
      } else if (key === 'bat_anim_flow_dir') {
        // v0.3.2 fix: also set HTML attribute for attribute selectors
        (node as HTMLElement).style.setProperty('--anim-flow-dir', String(value));
        if (root) root.setAttribute('data-anim-flow-dir', String(value));
      } else if (key === 'at_anim_fan_color') {
        // 末端风扇颜色：cool=#0EA5E9 / heat=#F97316 / off=#9CA3AF
        (node as HTMLElement).style.setProperty('--anim-fan-color', String(value));
      } else if (key === 'gs_anim_handle_color') {
        // 并网开关手柄色：on=#22C55E / off=#EF4444
        (node as HTMLElement).style.setProperty('--anim-handle-color', String(value));
      } else if (key === 'ts_anim_temp') {
        // v0.4.7: 温度传感器指针 (写到根 data-ts-temp 属性 + CSS 变量)
        if (root) {
          const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0.5;
          root.setAttribute('data-ts-temp', String(num));
          root.style.setProperty('--anim-ts-temp', String(num));
        }
        }
      } else if (key === 'pcm_anim_melt') {
        // v19 PCM 重构：只写 3 个 CSS 变量，SVG 端 calc() 算 6 个 hex 残影
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        const norm = Math.max(0, Math.min(1, num));
        const nodeEl = node as HTMLElement;
        nodeEl.style.setProperty('--pcm-melt', String(norm));
        // 反转色带（v0.4 紫蓝暖调）
        const stops: Array<[number, number, number, number]> = [
          [0.00, 0x1E, 0x1B, 0x4B], [0.20, 0x37, 0x33, 0xA3],
          [0.45, 0xDB, 0x27, 0x77], [0.65, 0xF9, 0x73, 0x16],
          [0.85, 0xFB, 0xBF, 0x24], [1.00, 0xFE, 0xF9, 0xC3],
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
        nodeEl.style.setProperty('--pcm-piece-color', `rgb(${r}, ${g}, ${b})`);
        // 气泡阈值 0.5
        const bubbleVis = norm < 0.5 ? 0 : Math.max(0, Math.min(1, (norm - 0.5) / 0.5));
        nodeEl.style.setProperty('--pcm-bubble-vis', String(bubbleVis));
      } else if (key === 'pcm_anim_transition') {
        // v0.4 PCM 重构：相变过渡时长（秒）→ --pcm-transition
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        (node as HTMLElement).style.setProperty('--pcm-transition', `${Math.max(0.3, num)}s`);
      } else if (key === 'grid_anim_state') {
        if (root) root.setAttribute('data-anim-grid-state', String(value));
      } else if (key === 'soc_low') {
        if (root) root.setAttribute('data-anim-soc-low', String(value));
      } else if (key === 'pv_anim_sun_x_group') {
        // panel group selector already handled by data-anim-sun-x
      } else if (key.includes('flow_speed') || key === 'tank_flow') {
        // 水箱气泡流速绑定（v0.3.1 新增，见 部件动画增强.md §5.2）
        const num = typeof value === 'number' ? value : parseFloat(String(value)) || 0;
        if (num <= 0) {
          (node as HTMLElement).style.setProperty('--anim-bubble-duration', '0s');
          (node as HTMLElement).style.setProperty('--anim-bubble-opacity', '0');
        } else {
          const dur = Math.max(0.6, Math.min(4, 5 / num));
          (node as HTMLElement).style.setProperty('--anim-bubble-duration', `${dur}s`);
          (node as HTMLElement).style.setProperty('--anim-bubble-opacity', '1');
        }
      } else if (key.includes('water_color')) {
        // 水温色（注入器会传入 hex 字符串）
        (node as HTMLElement).style.setProperty('--anim-water-color', String(value));
      } else if (key.includes('temp_color')) {
        (node as HTMLElement).style.setProperty('--anim-temp-color', String(value));
      } else if (key === 'hp_anim_outlet_temp_color') {
        // ⭐ M2 新增：热泵出风温度色（来自 PDF T2_PV）
        (node as HTMLElement).style.setProperty('--anim-outlet-temp-color', String(value));
      } else if (key === 'tank_anim_supply_temp_color') {
        // ⭐ M2 新增：水箱进水温度色（来自 PDF T4_PV）
        (node as HTMLElement).style.setProperty('--anim-supply-temp-color', String(value));
      } else if (key === 'tank_anim_return_temp_color') {
        // ⭐ M2 新增：水箱回水温度色（来自 PDF T5_PV）
        (node as HTMLElement).style.setProperty('--anim-return-temp-color', String(value));
      } else if (key === 'hp_outlet_temp' || key === 'outlet_temp') {
        // ⭐ M2 新增：热泵出风温度数值（注入器传入 "29℃" 字符串）
        // 已由通用 textContent 处理（见函数顶部 fallback）
      } else if (key === 'tank_supply_temp' || key === 'supply_temp') {
        // ⭐ M2 新增：水箱进水温度数值
      } else if (key === 'tank_return_temp' || key === 'return_temp') {
        // ⭐ M2 新增：水箱回水温度数值
      } else if (key === 'grid_voltage' || key === 'mains_voltage' || key === 'dc_voltage') {
        // ⭐ M2 新增：电压数值（注入器传入数字 + "V" 字符串）
        // 由通用 textContent 处理
      } else if (key === 'grid_current' || key === 'mains_current' || key === 'dc_current') {
        // ⭐ M2 新增：电流数值
        // 由通用 textContent 处理
      } else if (key === 'ambient_temp' || key === 'meta_ambient_temp') {
        // ⭐ M2 新增：环境温度（用于顶部信息栏）
        (node as HTMLElement).style.setProperty('--anim-ambient-temp', String(value));
      } else if (key === 'battery_alarm' || key === 'battery_protection' || key === 'battery_balance') {
        // ⭐ M2 新增：电池报警/保护/均衡文字（仅文字标签，不触发任何动画）
        // 由通用 textContent 处理；UI 用灰色背景显示
      }
    });
  });
}

/** 5. 注入动画状态字段（设置 data-anim-state 等属性） */
export function injectAnimStates(svg: SVGElement, animStates: Record<string, string>): void {
  Object.entries(animStates).forEach(([key, value]) => {
    // 找到最外层组件 g，设置 data-anim-state
    const root = svg.querySelector('[data-component-id]') as SVGElement;
    if (root) {
      root.setAttribute(`data-anim-${key}-state`, value);
    }
  });
}

/** 6. 一站式注入 */
export function injectAll(svg: SVGElement, opts: InjectOptions): void {
  if (opts.fields) injectFields(svg, opts.fields);
  if (opts.status) injectStatus(svg, opts.status);
  if (opts.levels) injectLevels(svg, opts.levels);
  if (opts.animations) injectAnimations(svg, opts.animations);
  if (opts.animStates) injectAnimStates(svg, opts.animStates);
}

/** 7. 加载 SVG 并注入数据 */
export async function loadAndInject(
  svgPath: string,
  mountEl: HTMLElement,
  opts: InjectOptions = {}
): Promise<SVGElement> {
  const res = await fetch(svgPath);
  const text = await res.text();
  mountEl.innerHTML = text;
  const svg = mountEl.querySelector('svg') as SVGElement;
  if (!svg) throw new Error(`Failed to load SVG: ${svgPath}`);
  injectAll(svg, opts);
  return svg;
}

/** 8. 不重新加载，直接对已挂载的 SVG 注入（用于数据更新） */
export function updateMounted(mountEl: HTMLElement, opts: InjectOptions): void {
  const svg = mountEl.querySelector('svg') as SVGElement;
  if (svg) injectAll(svg, opts);
}

/** 9. 为可点击部件绑定点击事件
 *
 * 用法：
 *   attachClickHandlers(mountEl, {
 *     'heat-pump': (svg) => {
 *       const root = svg.querySelector('[data-component-id]');
 *       const cur = root.getAttribute('data-anim-fan-state');
 *       root.setAttribute('data-anim-fan-state', cur === 'on' ? 'off' : 'on');
 *     },
 *   });
 */
export function attachClickHandlers(
  mountEl: HTMLElement,
  handlers: Record<string, (svg: SVGElement) => void>
): void {
  Object.entries(handlers).forEach(([componentId, handler]) => {
    const svg = mountEl.querySelector('svg') as SVGElement;
    if (!svg) return;
    const target = svg.querySelector(`[data-click-target="${componentId}"]`) as SVGElement;
    if (target) {
      target.style.cursor = 'pointer';
      target.addEventListener('click', (e) => {
        e.stopPropagation();
        handler(svg);
      });
    }
  });
}

/** 10. 温度色阈值计算（v0.3.2: 5 段 HSL 插值，0~100℃ 连续过渡）
 *  - 0~15℃  冰冷深蓝  hsl(230, 80%, 35%)
 *  - 15~30℃ 常温蓝    hsl(210, 85%, 50%)
 *  - 30~50℃ 温热黄    hsl(50,  90%, 55%)
 *  - 50~85℃ 警戒橙    hsl(25,  95%, 55%)
 *  - >85℃   过热红    hsl(0,   90%, 55%)
 */
export function tempColor(tempC: number, _threshold?: number): string {
  const c = Math.max(0, Math.min(120, tempC));
  const stops: Array<{ t: number; h: number; s: number; l: number }> = [
    { t: 0,  h: 230, s: 80, l: 35 },
    { t: 15, h: 210, s: 85, l: 50 },
    { t: 30, h: 50,  s: 90, l: 55 },
    { t: 50, h: 25,  s: 95, l: 55 },
    { t: 85, h: 0,   s: 90, l: 55 },
  ];
  if (c >= 85) return `hsl(0, 90%, 55%)`;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (c >= a.t && c <= b.t) {
      const r = (c - a.t) / (b.t - a.t);
      const h = a.h + (b.h - a.h) * r;
      const s = a.s + (b.s - a.s) * r;
      const l = a.l + (b.l - a.l) * r;
      return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
    }
  }
  return 'hsl(230, 80%, 35%)';
}

/** 11. 风扇转速归一化（0~1） */
export function fanSpeedNorm(value: number, max = 8): number {
  return Math.max(0, Math.min(1, value / max));
}

/** 12. 水位 y 坐标计算（0%=200, 100%=80） */
export function waterLevelY(percent: number): number {
  return 200 - percent * 120;
}
