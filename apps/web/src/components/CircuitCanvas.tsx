import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMPONENTS, SVG_FILES, VIEW_W, VIEW_H, type ComponentDef } from '../data/components';
import { useSimStore, type SimulationState } from '../store/simulation';
import { fetchSvg, injectAll, injectComponentRootState } from '../injector/injector';
import { derivePcmVisual } from '../engine/pcm';
import { LINE_COLORS } from '../data/cables';
import { METER_PALETTE, METER_FILES, type MeterType } from '../data/palettes';
import type { MeterInstance } from '../data/meters';
import { METER_BIND_LABELS } from '../data/meters';
import { buildMeterInjectData, buildPcmInjectData, readCell } from '../services/meterInject';
import { readDropType } from './PalettePanel';
import { useParticleAnimation } from '../hooks/useParticleAnimation';
import { usePvSunAnimation } from '../hooks/usePvSunAnimation';
import { useTransientSpark } from '../hooks/useTransientSpark';
import { TsPointer } from './TsPointer';
import { ComponentDetail } from './ComponentDetail';

const CLICKABLE = new Set([
  'pv-array', 'combiner-box', 'grid-switch', 'heat-pump',
  'pump', 'air-terminal', 'load', 'pcm', 'solar-air-cooler',
]);

// 可打开详情页的部件（双击触发）。比 CLICKABLE 范围更广。
// 不含 air-terminal：三态循环单击 + 单击减速方案见 handleComponentClick，
// 双击走 250ms timer 节流避免误触 cycle。
const DETAILABLE = new Set([
  'pv-array', 'combiner-box', 'grid', 'grid-switch', 'inverter',
  'battery', 'load', 'heat-pump', 'tank', 'pump', 'pcm', 'air-terminal', 'solar-air-cooler',
]);

const LED_COLORS: Record<string, string> = {
  running: '#22C55E', charging: '#22C55E', discharging: '#0EA5E9',
  cool: '#0EA5E9', heat: '#F97316', idle: '#9CA3AF', off: '#6B7280',
  standby: '#9CA3AF', stopped: '#9CA3AF', on: '#22C55E', connected: '#22C55E',
  disconnected: '#9CA3AF', fault: '#EF4444', warn: '#EAB308',
  solid: '#0EA5E9', liquid: '#F97316',
  in: '#22C55E', out: '#0EA5E9',
  online: '#22C55E', offline: '#9CA3AF',
};

function ledColor(state: string): string {
  return LED_COLORS[state] ?? '#9CA3AF';
}

function tempColor(t: number): string {
  // demo.html: 0~120 ℃ 全温度区间映射（蓝→绿→黄→红）
  // 滑块上限 100℃ + 物理余量到 120℃
  const c = Math.max(0, Math.min(120, t));
  if (c >= 100) return 'hsl(0, 90%, 55%)';  // 100℃+ 红色
  if (c >= 85) return 'hsl(15, 90%, 55%)';  // 85~100℃ 深橙
  const stops: Array<[number, number, number, number]> = [
    [0,  220, 85, 50],   // 0℃ 冷蓝
    [15, 200, 85, 55],   // 15℃ 蓝
    [30, 50,  90, 55],   // 30℃ 青
    [50, 30,  90, 55],   // 50℃ 绿
    [70, 50,  90, 55],   // 70℃ 黄绿
    [85, 35,  95, 55],   // 85℃ 黄
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t1, h1, s1, l1] = stops[i];
    const [t2, h2, s2, l2] = stops[i + 1];
    if (c >= t1 && c <= t2) {
      const r = (c - t1) / (t2 - t1);
      return `hsl(${(h1 + (h2 - h1) * r).toFixed(0)}, ${(s1 + (s2 - s1) * r).toFixed(0)}%, ${(l1 + (l2 - l1) * r).toFixed(0)}%)`;
    }
  }
  return 'hsl(220, 85%, 50%)';
}

function buildInjectData(state: SimulationState) {
  // 部件容量标签（从 data/components.ts 取 spec）
  const capOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.spec ?? '';
  // PCM 视觉派生（融化比例驱动，纯函数）
  const pcm = derivePcmVisual(state);
  const ratingOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.rating ?? '';

  // XLSX 电池字段读取（电压/电流/SOC；剩余容量无 UI 消费，不做直读）
  const batV = readCell(state, '电压(V)');
  const batA = readCell(state, '电流(A)');
  const batSocX = readCell(state, 'SOC(%)');

  // 负载功率进度条归一化（0..100，对应 SVG bg 宽度 100px）
  // Fix B1：改用独立滑块 load_power_kw（替代旧 pv_power 派生）
  const loadBarNorm = Math.max(0, Math.min(100, (state.load_power_kw / 6) * 100));
  // GS 手柄球颜色（绿=合闸/红=分闸）
  const gsHandleBallColor = state.gs_on ? '#22C55E' : '#EF4444';
  const sacState = state.sac_on
    ? (state.sac_water_level <= 10 ? 'low-water' : 'on')
    : 'off';
  // 注意：ts_mercury 不在此处几何注入 — temp-sensor.svg 内 .anim-ts-mercury 的 height/transform
  // 已由 CSS `var(--anim-ts-temp)` 驱动（injectAnimations 的 ts_anim_temp 通道）。
  // 若再通过 geometry 写 width/height/y 会与 CSS 冲突，反而破坏动画。

  const fields: Record<string, string> = {
    // === PV ===
    pv_power: state.pv_power.toFixed(2) + ' kW',
    pv_progress: Math.round(state.pv_power / 5 * 100) + '%',
    pv_capacity: capOf('pv-array'),
    sun_intensity: Math.round(state.pv_sun * 100) + '%',
    // === IV ===
    iv_capacity: capOf('inverter'),
    iv_dc_voltage: '380 V',
    iv_dc_current: (state.pv_power / 0.38).toFixed(1) + ' A',
    iv_ac_voltage: '220 V',
    iv_ac_freq: '50 Hz',
    // === Bat ===
    bat_soc: batSocX != null ? Math.round(batSocX) + '%' : Math.round(state.bat_soc) + '%',
    // Fix B2：电池状态由 battery_power_kw 驱动（正=充电/负=放电/0=待机）
    // XLSX 有电流时：电流 >0 = 放电，<0 = 充电
    bat_status_text: batA != null
      ? (batA > 0 ? '放电' : batA < 0 ? '充电' : '待机')
      : (state.battery_power_kw > 0 ? '充电' : state.battery_power_kw < 0 ? '放电' : '待机'),
    bat_status_label: batA != null
      ? (batA > 0 ? 'DCH' : batA < 0 ? 'CHG' : 'IDLE')
      : (state.battery_power_kw > 0 ? 'CHG' : state.battery_power_kw < 0 ? 'DCH' : 'IDLE'),
    bat_capacity: capOf('battery'),
    bat_label: ratingOf('battery'),
    bat_voltage: batV != null ? batV.toFixed(1) : (state.battery_power_kw > 0 ? '53.0' : '—'),
    bat_current: batA != null ? batA.toFixed(1) : (state.battery_power_kw > 0 ? (Math.abs(state.battery_power_kw) / 0.053).toFixed(1) : '—'),
    // === CB ===
    cb_status_text: state.cb_connected ? '合闸' : '分闸',
    cb_capacity: capOf('combiner-box'),
    cb_spec: ratingOf('combiner-box'),
    cb_pv_inputs: String(Math.min(4, Math.ceil(state.pv_power / 1.5))) + ' 路',
    cb_label: 'CB',
    // === Grid ===
    grid_label: '并网',
    grid_spec: 'AC 380V · 50Hz',
    grid_capacity: capOf('grid'),
    // === GS ===
    gs_capacity: capOf('grid-switch'),
    gs_status_text: state.gs_on ? '● 合闸' : '● 分闸',
    gs_label_on: 'ON',
    gs_label_off: 'OFF',
    gs_handle: state.gs_on ? 'ON' : 'OFF',
    // === HP ===
    hp_status_text: state.hp_on ? '运行' : '待机',
    hp_temp: Math.round(state.hp_temp) + '℃',
    hp_power: state.hp_power.toFixed(1) + ' kW',
    hp_capacity: capOf('heat-pump'),
    hp_cop: 'COP 3.8',
    hp_code: 'R32',
    hp_mode: state.at_mode === 'cool' ? 'COOL' : state.at_mode === 'heat' ? 'HEAT' : 'OFF',
    hp_mode_icon: state.at_mode === 'cool' ? '❄' : state.at_mode === 'heat' ? '♨' : '—',
    // === Tank ===
    tank_temp: Math.round(state.tank_temp) + '℃',
    tank_volume: Math.round(state.tank_volume) + '%',
    tank_flow: state.tank_flow.toFixed(1) + ' m³/h',
    tank_capacity: capOf('tank'),
    tank_threshold: state.tank_temp > 85 ? '>85℃' : (state.tank_temp === 85 ? '=85℃' : '≤85℃'),
    // === Pump ===
    pump_flow: state.pump_flow.toFixed(1) + ' m³/h',
    pump_status_text: state.pump_on ? '运行' : '停机',
    pump_capacity: capOf('pump'),
    pump_power: state.pump_flow.toFixed(2),
    pump_head: 'H=3m',
    pump_flow_label: state.pump_flow.toFixed(1),
    // === AT ===
    at_temp: Math.round(state.at_temp) + '℃',
    at_status_text: state.at_mode === 'cool' ? '制冷' : state.at_mode === 'heat' ? '制热' : '关机',
    at_capacity: capOf('air-terminal'),
    at_mode_label: state.at_mode === 'cool' ? '❄ 制冷' : state.at_mode === 'heat' ? '♨ 制热' : '⏻ 关机',
    at_mode: state.at_mode === 'cool' ? '❄ COOL' : state.at_mode === 'heat' ? '♨ HEAT' : 'OFF',
    at_set_temp: Math.round(state.at_temp) + '℃',
    at_set_label: '设定',
    at_fan_speed_label: state.at_mode === 'off' ? '停' : '中',
    at_count: '3 台',
    // === Solar air cooler（独立水箱/水泵/风机，不接中央水路）===
    sac_water_level: Math.round(state.sac_water_level) + '%',
    sac_water_temp: Math.round(state.sac_water_temp) + '℃',
    sac_outlet_temp: sacState === 'on' ? Math.round(state.sac_outlet_temp) + '℃' : '--',
    sac_power: sacState === 'on' ? (0.08 + state.sac_fan_speed * 0.16).toFixed(2) + ' kW' : '0.00 kW',
    // === PCM ===（T0/T1 双相变材料：按 pcm_temp_select 取温度 + 数据集当前行）
    ...(() => {
      const pcmData = buildPcmInjectData(state);
      const liveTxt = pcmData.liveTemp == null
        ? pcm.tempText
        : pcmData.liveTemp.toFixed(1) + '℃';
      return {
        pcm_temp: liveTxt,
        pcm_temp_select: pcmData.selectLabel,
        pcm_melt_text: pcm.meltText,
        pcm_status_text: pcm.statusText,
        pcm_capacity: capOf('pcm'),
      };
    })(),
    // === Load ===
    load_summary: state.at_mode === 'off' ? '待机 0.0 kW' : `${state.load_power_kw.toFixed(2)} kW · 客厅`,
    load_room: '客厅 · 14㎡',
    load_weather: '晴 26℃',
    // 实时时钟字段：在 buildInjectData 中**不**写入 fields — 由 ComponentSlot 的
    // setInterval 直接更新 SVG [data-field="real_clock"] 文本节点（不在 React render path），
    // 保证时钟跟随组件卡片一起移动（不再用 React 覆盖层）。
    // （保留此注释作为字段语义说明。）
    fridge_temp: '4℃',
    // 注：PM/TS 仪表字段不再在 buildInjectData 注入（M2-β 起 MeterSlot 用
    // buildMeterInjectData 按 bind 注入真实值；此处旧 pm_*/ts_* 字段已移除）
  };

  const status: Record<string, string> = {
    // === PV 状态 LED（status_glow + status_led）===
    'status_glow':        ledColor(state.pv_on ? 'on' : 'off'),
    'status_led':         ledColor(state.pv_on ? 'on' : 'off'),
    // === CB 状态 LED（cb_led 已有；补 cb_led_glow + 报警 LED）===
    'cb_led_glow':        ledColor(state.cb_connected ? 'connected' : 'disconnected'),
    'cb_led':             ledColor(state.cb_connected ? 'connected' : 'disconnected'),
    'cb_alarm_glow':      '#FCD34D',  // 报警 LED 默认琥珀色（M1 范围：固定色，报警逻辑由 M2 引擎驱动）
    'cb_alarm_led':       '#EAB308',
    // === Grid 离线 LED（红色光晕）===
    'grid_offline_glow':  ledColor('online'),
    'grid_offline_led':   ledColor('online'),
    // === GS 合闸 LED（gs_led_on 已有；补 gs_led_glow_on + 分闸 LED gs_led_off）===
    'gs_led_glow_on':     ledColor(state.gs_on ? 'on' : 'off'),
    'gs_led_on':          ledColor(state.gs_on ? 'on' : 'off'),
    'gs_led_off':         state.gs_on ? '#6B7280' : '#EF4444',  // 合闸时灭/分闸时红
    // === GS 手柄球（绿=合闸/红=分闸）—— 走 geometry.fill 通道（用户归类为 geometry 而非 LED）===
    // === Inverter 4 路 LED（PV / Bat / Grid / Load）===
    'iv_pv_led_glow':     ledColor(state.pv_on ? 'on' : 'off'),
    'iv_pv_led':          ledColor(state.pv_on ? 'on' : 'off'),
    'iv_bat_led_glow':    ledColor(state.bat_soc > 0 ? 'on' : 'off'),
    'iv_bat_led':         ledColor(state.bat_soc > 0 ? 'on' : 'off'),
    'iv_grid_led_glow':   ledColor('online'),
    'iv_grid_led':        ledColor('online'),
    'iv_load_led':        ledColor(state.load_on ? 'on' : 'off'),
    // === Battery 状态 LED（bat_status_led 已有；补 bat_status_glow）===
    'bat_status_glow':    batA != null
      ? ledColor(batA > 0 ? 'discharging' : batA < 0 ? 'charging' : 'idle')
      : ledColor(state.bat_soc > 50 ? 'charging' : 'discharging'),
    'bat_status_led':     batA != null
      ? ledColor(batA > 0 ? 'discharging' : batA < 0 ? 'charging' : 'idle')
      : ledColor(state.bat_soc > 50 ? 'charging' : 'discharging'),
    // === HP 状态 LED ===
    'hp_status_glow':     ledColor(state.hp_on ? 'running' : 'standby'),
    'hp_status_led':      ledColor(state.hp_on ? 'running' : 'standby'),
    // === Tank 状态 LED（tank_status_led 已有；补 tank_status_glow + tank_temp_led 由 tank_anim_temp_color 通道覆盖）===
    'tank_status_glow':   ledColor(state.pump_on ? 'running' : 'standby'),
    'tank_status_led':    ledColor(state.pump_on ? 'running' : 'standby'),
    'tank_temp_led':      tempColor(state.tank_temp),
    // === Pump 状态 LED（pump_status_led/led2 已有；补 glow1 + glow2）===
    'pump_status_glow':   ledColor(state.pump_on ? 'running' : 'stopped'),
    'pump_status_led':    ledColor(state.pump_on ? 'running' : 'stopped'),
    'pump_status_glow2':  ledColor(state.pump_on ? 'running' : 'stopped'),
    'pump_status_led2':   ledColor(state.pump_on ? 'running' : 'stopped'),
    // === AT 状态 LED（at_status_led 已有；补 at_status_glow）===
    'at_status_glow':     ledColor(state.at_mode),
    'at_status_led':      ledColor(state.at_mode),
    'sac_status_led':     ledColor(sacState === 'on' ? 'running' : sacState === 'low-water' ? 'warn' : 'off'),
    // === PCM（pcm_status_led/glow 已有）===
    'pcm_status_led':     pcm.color,
    'pcm_status_glow':    pcm.color,
    // === Load 设备 LED（lamp_glow/lamp_led + fridge_status）===
    'lamp_glow':          ledColor(state.load_on ? 'on' : 'off'),
    'lamp_led':           ledColor(state.load_on ? 'on' : 'off'),
    'fridge_status':      ledColor(state.load_on ? 'on' : 'off'),
    // 注：PM/TS 内部 LED 不再在 buildInjectData 注入（M2-β 起仪表走 buildMeterInjectData）
  };

  const statusText: Record<string, string> = {
    // Fix B2：电池文字色由实际放电/充电方向决定（统一约定：XLSX 电流 >0=放电 / battery_power_kw >0=充电）
    // XLSX 有真实电流时：>0=放电（蓝）/ <0=充电（绿）/ =0=待机（灰）
    'bat_status_text':  batA != null
      ? ledColor(batA > 0 ? 'discharging' : batA < 0 ? 'charging' : 'idle')
      : ledColor(state.battery_power_kw > 0 ? 'charging' : state.battery_power_kw < 0 ? 'discharging' : 'idle'),
    'pump_status_text': ledColor(state.pump_on ? 'running' : 'stopped'),
    'at_status_text':   ledColor(state.at_mode),
    'sac_outlet_temp':  sacState === 'on' ? '#7DD3FC' : '#94A3B8',
    'hp_status_text':   ledColor(state.hp_on ? 'running' : 'standby'),
    'pcm_status_text':  pcm.color,
    // M1.5 Step 5: LCD 文字色（绿=合闸/红=分闸）
    // 文本内容由 fields 通道写入（合闸/分闸），颜色由 statusText 通道 fill 覆盖
    'gs_status_text':   state.gs_on ? '#22C55E' : '#EF4444',
    'cb_status_text':   state.cb_connected ? '#22C55E' : '#EF4444',
  };

  const levels: Record<string, number> = {
    bat_charge_level: Math.round((batSocX != null ? batSocX : state.bat_soc) / 10),
  };

  const animations: Record<string, any> = {
    // v23 移除 pv_anim_sun_x / pv_anim_sun_y（CSS 端 calc(--anim-sun-duration + ...) 自动算轨道，无需手动传 xy）
    pv_anim_sun_speed:    state.pv_sun,
    pv_anim_panel_speed:  state.pv_sun,
    hp_anim_fan:          state.hp_on ? state.hp_power : 0,
    pump_anim_impeller:   state.pump_on ? Math.max(0, Math.min(1, state.pump_flow / 5)) : 0,
    at_anim_fan_speed:    state.at_fan_speed,
    // A2: 末端风盘出风粒子速度（at_anim_air_flow 走 --anim-air-speed，独立于叶片旋转速度）
    at_anim_air_flow:     state.at_fan_speed,
    sac_anim_fan_speed:   sacState === 'on' ? state.sac_fan_speed : 0,
    sac_anim_air_flow:    sacState === 'on' ? state.sac_fan_speed : 0,
    sac_anim_pump_flow:   sacState === 'on' ? state.sac_fan_speed : 0,
    sac_anim_water_fill:  state.sac_water_level / 100,
    sac_anim_water_color: tempColor(state.sac_water_temp),
    // A3: 汇流箱 PV 输入 LED 亮数（cb_anim_pv_inputs 走 --anim-pv-inputs，按 0~1 归一化）
    cb_anim_pv_inputs:    state.pv_power,
    tank_anim_water_fill: state.tank_volume / 100,
    tank_anim_temp_color: tempColor(state.tank_temp),
    // M1.5 Round 8 修复：tank_anim_flow_speed 重新启用（SVG 端 .anim-flow-bubble CSS 改用 var(--anim-bubble-duration)）
    tank_anim_flow_speed: state.pump_on ? state.tank_flow : 0,
    pcm_anim_melt:        pcm.melt,
    pcm_anim_transition:  pcm.transitionSec,
    ts_anim_temp:         Math.max(0, Math.min(1, (state.tank_temp - 10) / 90)),  // 0..1 映射 10~100℃
    // Fix B2：电池流向由 battery_power_kw 决定（<0 充电=flow in, >0 放电=flow out, =0 待机=idle）
    // XLSX 有电流时：电流 >0 = 放电（out），<0 = 充电（in）
    bat_anim_flow_dir: batA != null
      ? (batA < 0 ? 'in' : batA > 0 ? 'out' : 'idle')
      : (state.battery_power_kw < 0 ? 'in' : state.battery_power_kw > 0 ? 'out' : 'idle'),
    soc_low: (batSocX != null ? batSocX : state.bat_soc) < 20,
  };

  const geometry: Record<string, { width?: number; height?: number; x?: number; y?: number; cx?: number; cy?: number; fill?: string }> = {
    // 蓄电池 SOC 进度条（bg=140，filled=bat_soc/100*140）
    bat_progress_bar: { width: Math.max(0, Math.min(140, ((batSocX != null ? batSocX : state.bat_soc) / 100) * 140)) },
    // 室内用电功率进度条（bg=100，filled=pv_power/6*100；CSS .anim-load-bar 过渡 0.5s；M1.5 Round 9 替代原 iv_power）
    load_power_bar:   { width: loadBarNorm },
    // PCM 融化比例进度条（bg=140，filled=pcm.melt*140；CSS .anim-pcm-bar 过渡 0.5s）
    pcm_melt_bar:     { width: pcm.melt * 140 },
    // GS 手柄球 fill（绿=合闸/红=分闸；用户归类为 geometry）
    gs_handle_ball:   { fill: gsHandleBallColor },
    // ts_mercury 不在此注入 → 走 CSS 通道 (见 ts_anim_temp)
  };

  const animStates: Record<string, string> = {
    refrigerant: state.at_mode === 'cool' ? 'cool' : state.at_mode === 'heat' ? 'heat' : 'idle',
    fan: state.hp_on ? 'on' : 'off',
    impeller: state.pump_on ? 'on' : 'off',
    'iv-mode': state.at_mode === 'off' ? 'idle' : 'dc-to-ac',
    phase: pcm.phase,
    'pump-running': state.pump_on ? 'true' : 'false',
  };

  return { fields, status, statusText, levels, animations, geometry, animStates };
}

const CLICK_ACTIONS: Record<string, (s: ReturnType<typeof useSimStore.getState>) => void> = {
  'pv-array':      (s) => s.togglePv(),
  'combiner-box':  (s) => s.toggleCb(),
  'grid-switch':   (s) => s.toggleGs(),
  'heat-pump':     (s) => s.toggleHp(),
  'pump':          (s) => s.togglePump(),
  'air-terminal':  (s) => s.cycleAt(),
  'solar-air-cooler': (s) => s.toggleSolarAirCooler(),
  'load':          (s) => s.toggleLoad(),  // Fix B6：原 cycleLoad 重命名
  'pcm':           (s) => s.setPcmTempSelect(s.pcm_temp_select === 'T0' ? 'T1' : 'T0'),
};

interface ComponentSlotProps {
  comp: ComponentDef;
  state: SimulationState;
  onClick: (compId: string, e?: React.MouseEvent) => void;
  onDoubleClick?: (compId: string, e: React.MouseEvent) => void;
  /** 外部 ref，用于 cable overlay 计算屏幕坐标 */
  svgRef?: React.MutableRefObject<SVGSVGElement | null>;
}

/** 单个部件 SVG：fetch → 注入 → 渲染为独立 <svg> 元素（不像之前是 master svg 内的 <g>） */
function ComponentSlot({ comp, state, onClick, onDoubleClick, svgRef }: ComponentSlotProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [svgContent, setSvgContent] = useState<SVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const filename = SVG_FILES[comp.id];
    if (!filename) return;

    fetchSvg('/base-elements/' + filename)
      .then((doc) => {
        if (cancelled) return;
        setSvgContent(doc.documentElement as unknown as SVGElement);
      })
      .catch((err) => console.error(`Failed to load ${filename}:`, err));

    return () => { cancelled = true; };
  }, [comp.id]);

  // M1.5 Step 1+: 克隆只在 svgContent 变化（初始 fetch）时发生一次；state 变化直接在 live DOM 上 mutate。
  //   - 修复 CSS transition（手柄旋转 0.4s、手柄球 0.3s、功率条 0.5s）
  //   - SVG <style> 只解析一次（性能提升）
  //   - 12 部件 SVG 全部受益（不仅 grid-switch / load）
  useEffect(() => {
    if (!svgContent || !ref.current) return;
    ref.current.innerHTML = '';
    Array.from(svgContent.children).forEach((child) => {
      ref.current!.appendChild(child.cloneNode(true));
    });
    // ★ 关键：克隆后立刻注入一次，避免初次渲染停留在 SVG 占位文本
    const data = buildInjectData(state);
    injectAll(ref.current, data);
    injectComponentRootState(ref.current, state, comp.id);
  }, [svgContent]);

  useEffect(() => {
    if (!ref.current) return;
    const data = buildInjectData(state);
    injectAll(ref.current, data);
    injectComponentRootState(ref.current, state, comp.id);
  }, [state, comp.id]);

  // 实时时钟注入（仅 load 组件）：直接操作 SVG 内的 [data-field="real_clock"] 文本节点
  //  * 注入到 SVG <g> 内部 → 随组件卡片 transform 一起移动（不再使用 React 覆盖层）
  //  * 每秒 setInterval + 直接 setTextContent，不触发 React 渲染或 SVG 克隆
  //  * load_on=false / animationOn=false 时清空文本（CCTV 屏关）
  //  * 两个文本节点：电视 (font-size 18) 用 HH:MM:SS；笔记本 (font-size 6) 用 HH:MM
  useEffect(() => {
    if (comp.id !== 'load') return;
    if (!state.animationOn) {
      const nodes = ref.current?.querySelectorAll<SVGTextElement>('[data-field="real_clock"]');
      nodes?.forEach((n) => { n.textContent = ' '; });
      return;
    }
    const formatTime = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    const tick = () => {
      const svg = ref.current;
      if (!svg) return;
      const nodes = svg.querySelectorAll<SVGTextElement>('[data-field="real_clock"]');
      nodes.forEach((n) => {
        const fs = n.getAttribute('font-size');
        n.textContent = fs === '6' ? formatTime().slice(0, 5) : formatTime();
      });
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [comp.id, state.animationOn, state.load_on]);

  // PV 太阳 RAF 动画（非 PV 部件槽位 hook 内部 early-return，无副作用）
  usePvSunAnimation(ref, state);

  // M1.5 Step 5: 点击瞬时电火花
  // - grid-switch: SVG 内 gs_anim_spark 默认 display:none → 切换时点亮 800ms
  // - combiner-box: SVG 内新增 cb_anim_arc → 切换时点亮 800ms（与持续 flicker 并存）
  // 其它部件 selector 不存在 → hook 内部 early-return，无副作用
  useTransientSpark(ref, 'gs_on', '[data-animation-id="gs_anim_spark"]');
  useTransientSpark(ref, 'cb_connected', '[data-animation-id="cb_anim_arc"]');

  const isClickable = CLICKABLE.has(comp.id);
  const isDetailable = DETAILABLE.has(comp.id);

  // 暴露 ref 给父级（用于 cable overlay 定位）
  useEffect(() => {
    if (svgRef) svgRef.current = ref.current;
  }, [svgRef]);

  return (
    <svg
      ref={ref}
      className={`component-svg ${isClickable ? 'clickable' : ''} ${isDetailable ? 'detailable' : ''}`}
      data-component-id={comp.id}
      viewBox="0 0 240 240"
      preserveAspectRatio="xMidYMid meet"
      onClick={isClickable ? (e) => {
        e.stopPropagation();
        onClick(comp.id, e);
      } : undefined}
      onDoubleClick={isDetailable && onDoubleClick ? (e) => {
        e.stopPropagation();
        onDoubleClick(comp.id, e);
      } : undefined}
    />
  );
}

interface MeterSlotProps {
  meter: MeterInstance;
  state: SimulationState;
}

/** 仪表卡片 SVG：与 ComponentSlot 同模式，源文件用 METER_FILES
 *  - 注入数据 = buildMeterInjectData(state, meter)：按 bind 从数据集当前行取真实值
 */
function MeterSlot({ meter, state }: MeterSlotProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [svgContent, setSvgContent] = useState<SVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const filename = METER_FILES[meter.type];
    if (!filename) return;

    fetchSvg('/base-elements/' + filename)
      .then((doc) => {
        if (cancelled) return;
        setSvgContent(doc.documentElement as unknown as SVGElement);
      })
      .catch((err) => console.error(`Failed to load ${filename}:`, err));

    return () => { cancelled = true; };
  }, [meter.type]);

  // 克隆只在 svgContent 变化时发生一次；state 变化直接在 live DOM 上 mutate（对齐 ComponentSlot 模式）
  useEffect(() => {
    if (!svgContent || !ref.current) return;
    ref.current.innerHTML = '';
    Array.from(svgContent.children).forEach((child) => {
      ref.current!.appendChild(child.cloneNode(true));
    });
    const data = buildMeterInjectData(state, meter);
    injectAll(ref.current, data);
  }, [svgContent]);

  useEffect(() => {
    if (!svgContent || !ref.current) return;
    const data = buildMeterInjectData(state, meter);
    injectAll(ref.current, data);
    injectComponentRootState(ref.current, state, meter.type);
  }, [svgContent, state, meter.type, meter.bind]);

  return (
      <svg
        ref={ref}
        className="component-svg meter-svg-scaled"
        data-component-id={meter.type}
        viewBox="0 0 240 240"
        // v0.6: PM 三行大字布局渲染 80px（略大于 TS 72px，仍不破坏整体布局）
        width={meter.type === 'power-meter' ? 80 : 72}
        height={meter.type === 'power-meter' ? 80 : 72}
        preserveAspectRatio="xMidYMid meet"
      />
  );
}

/**
 * 沿 anchorId 链 walk 到根浮动端点（owner / joint）。
 * - 若 chain 终止于组件锚点 → 返回 null（无 owner）
 * - 若 chain 终止于浮动 cable 端点 → 返回该端点（它是 joint，拖动时需联动）
 * - cycle 防护：visited Set 防止无限递归
 */
function findOwnerEnd(
  cableId: string,
  end: 'from' | 'to',
  visited: Set<string> = new Set(),
): { cableId: string; end: 'from' | 'to' } | null {
  const cables = useSimStore.getState().cables;
  const cable = cables.find((c) => c.id === cableId);
  if (!cable || cable.segments.length === 0) return null;
  const anchorId = end === 'from'
    ? cable.segments[0].fromAnchorId
    : cable.segments[cable.segments.length - 1].toAnchorId;
  if (!anchorId) return { cableId, end };  // 走到浮动端点 → 它是 joint

  const visitKey = `${cableId}.${end}`;
  if (visited.has(visitKey)) {
    console.warn('[cable] cycle detected:', [...visited, visitKey].join(' -> '));
    return null;
  }
  visited.add(visitKey);

  if (anchorId.startsWith('cable:')) {
    const m = anchorId.match(/^cable:(.+)\.(from|to)$/);
    if (!m) return null;
    return findOwnerEnd(m[1], m[2] as 'from' | 'to', visited);
  }
  // 终止于组件锚点或仪表卡片锚点 → 无 owner
  return null;
}

export function CircuitCanvas() {
  const state = useSimStore();
  const positions = useSimStore((s) => s.positions);
  const meters = useSimStore((s) => s.meters);
  const selectedMeter = useSimStore((s) => s.selectedMeter);
  const editMode = useSimStore((s) => s.editMode);
  const cableDrag = useSimStore((s) => s.cableDrag);
  const selectComponent = useSimStore((s) => s.selectComponent);
  const selectCable = useSimStore((s) => s.selectCable);
  const selectMeter = useSimStore((s) => s.selectMeter);
  const addCable = useSimStore((s) => s.addCable);
  const setCableDrag = useSimStore((s) => s.setCableDrag);
  const setPosition = useSimStore((s) => s.setPosition);
  const setStoreDragging = useSimStore((s) => s.setDragging);
  const addMeter = useSimStore((s) => s.addMeter);
  const moveMeter = useSimStore((s) => s.moveMeter);
  const setCardPositions = useSimStore((s) => s.setCardPositions);

  const canvasRef = useRef<HTMLDivElement>(null);
  const cableOverlayRef = useRef<SVGSVGElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  /** 部件 / 仪表卡片 mousedown 信息：用于在 click 时判断是否真正发生 drag（> 4px） */
  const cardDownRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ w: 1200, h: 800 });
  /** 世界坐标 → 屏幕坐标：screen = world × zoom + pan。所有持久化位置均为世界坐标。 */
  const [view, setView] = useState({ x: 20, y: 20, zoom: 0.65 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fittedRef = useRef(false);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  // M1.5 Round 13: 部件详情弹窗（双击部件触发）
  const [detailCompId, setDetailCompId] = useState<string | null>(null);
  // I2: Esc 取消拖动。当前活跃拖动回调（startDragCard / startDragEnd 设置自身 cancel 函数）
  const cancelDragRef = useRef<(() => void) | null>(null);

  /** 跟踪画布尺寸，用于 viewBox 1800×1100 → 屏幕像素的缩放 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setCanvasSize({ w: rect.width, h: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  /** 部件默认位置：稳定世界坐标，不再随浏览器窗口尺寸变化。 */
  const defaultPositions = useMemo<Record<string, { x: number; y: number }>>(() => {
    const map: Record<string, { x: number; y: number }> = {};
    for (const c of COMPONENTS) {
      map[c.id] = { x: c.x, y: c.y };
    }
    return map;
  }, []);

  /**
   * 初次挂载 + 画布尺寸变化时同步 cardPositions 到 store。
   * 之前 syncCardPositionsToStore 只在 drop / drag end 时调用，
   * 导致 TsPointer 在用户首次操作前拿不到卡片位置而隐藏。
   * 这里 + ResizeObserver 保证 TsPointer 一直可见。
   */
  useEffect(() => {
    syncCardPositionsToStore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasSize.w, canvasSize.h]);

  // I2: Esc 取消当前拖动（卡片 / 线缆端点）
  // - 调用 cancelDragRef.current() 让 onMove / onUp 走 cancelled 分支 noop
  // - 同步清掉 cableDrag（store）+ draggingCardId（local）+ store draggingId
  // - 不重置已写入的位置 / floating 坐标（用户拖到的位置保留，可再次点击继续拖）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (cancelDragRef.current) {
        cancelDragRef.current();
        cancelDragRef.current = null;
      }
      if (useSimStore.getState().cableDrag) {
        setCableDrag(null);
      }
      if (draggingCardId) {
        setDraggingCardId(null);
        setStoreDragging(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draggingCardId, setCableDrag, setStoreDragging]);

  /**
   * 卡片拖动：mousedown → 启动监听 → 移动 > 4px 视为 drag，否则视为 click。
   * moveTo 回调决定位置写到哪里：
   *   - 部件卡片 → setPosition(id, x, y)
   *   - 仪表卡片 → moveMeter(id, {x, y})
   *
   * I2: cancelled 标志用于 Esc 取消拖动。onMove / onUp 在 cancelled=true 时 noop，
   * 但仍然会执行 listener 移除（保证后续拖拽能重新挂载）。
   */
  const startDragCard = (
    e: React.MouseEvent,
    id: string,
    currentPos: { x: number; y: number },
    moveTo: (pos: { x: number; y: number }) => void,
  ) => {
    let moved = false;
    let cancelled = false;
    const startX = e.clientX;
    const startY = e.clientY;
    cardDownRef.current = { id, x: startX, y: startY };
    // 注册 cancel 回调（Esc 时调用）
    cancelDragRef.current = () => { cancelled = true; };
    const onMove = (ev: MouseEvent) => {
      if (cancelled) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      moveTo({ x: currentPos.x + dx / viewRef.current.zoom, y: currentPos.y + dy / viewRef.current.zoom });
    };
    const onUp = () => {
      if (cancelled) {
        // Esc 已清状态，listener 只清理
        cancelDragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        return;
      }
      // 注意：不要在这里清空 cardDownRef，handleComponentClick 需要根据距离判断是否抑制
      // ref 由 handleComponentClick 消费后清空
      setDraggingCardId(null);
      setStoreDragging(null);
      cancelDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // air-terminal 是 3 态循环（cool/heat/off），双击开详情时会被解读成两次 click
  // → 状态会跨两步（cool→off）。用 250ms 节流延后执行单击动作；
  //   如果 250ms 内来了第二次 click（=双击），清除待执行的单击。
  const atClickTimerRef = useRef<{ id: ReturnType<typeof setTimeout> | null }>({ id: null });
  // heat-pump 与 air-terminal 同款 250ms 防抖：单击切换 hp_on，双击开详情时避免
  // 两次 click 各自翻转 hp_on（净效果 = 原状态，但会让制冷剂短暂启停）→ 同样延后执行。
  const hpClickTimerRef = useRef<{ id: ReturnType<typeof setTimeout> | null }>({ id: null });

  useEffect(() => {
    return () => {
      if (atClickTimerRef.current.id !== null) {
        clearTimeout(atClickTimerRef.current.id);
        atClickTimerRef.current.id = null;
      }
      if (hpClickTimerRef.current.id !== null) {
        clearTimeout(hpClickTimerRef.current.id);
        hpClickTimerRef.current.id = null;
      }
    };
  }, []);

  const handleComponentClick = (compId: string, e?: React.MouseEvent) => {
    // 守卫：如果本次按下到释放距离 > 4px 视为拖动，抑制 click 触发状态切换
    const down = cardDownRef.current;
    if (down && down.id === compId && e) {
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      cardDownRef.current = null;
      if (dist > 4) return;  // 拖动了 → 不触发 click
    } else {
      cardDownRef.current = null;
    }

    const runAction = () => {
      const s = useSimStore.getState();
      const action = CLICK_ACTIONS[compId];
      if (action) action(s);
    };

    if (compId === 'air-terminal') {
      // 250ms 节流：双击会触发 2 次 click，第一次排队，第二次来了就取消
      if (atClickTimerRef.current.id !== null) {
        clearTimeout(atClickTimerRef.current.id);
        atClickTimerRef.current.id = null;
        return;  // 第 2 次 click（=双击的尾巴）→ 取消前面排队的单击
      }
      atClickTimerRef.current.id = setTimeout(() => {
        atClickTimerRef.current.id = null;
        runAction();
      }, 250);
      return;
    }

    if (compId === 'heat-pump') {
      // 250ms 节流：镜像 air-terminal 防抖（单击切 hp_on，双击时第二次 click 取消排队）
      if (hpClickTimerRef.current.id !== null) {
        clearTimeout(hpClickTimerRef.current.id);
        hpClickTimerRef.current.id = null;
        return;  // 第 2 次 click（=双击的尾巴）→ 取消前面排队的单击
      }
      hpClickTimerRef.current.id = setTimeout(() => {
        hpClickTimerRef.current.id = null;
        runAction();
      }, 250);
      return;
    }

    runAction();
  };

  /** 双击部件 SVG：打开部件详情弹窗
   *  - onClick 仍会因两次 click 各触发一次状态切换（净效果 = 0 = 原状态），可接受
   *  - 双击即"覆盖式"操作：先点开再看，不破坏既有单击切换
   */
  const handleSvgDoubleClick = (compId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDetailCompId(compId);
  };

  /** 屏幕坐标 → 画布内像素坐标 */
  const screenToCanvas = (sx: number, sy: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const current = viewRef.current;
    return { x: (sx - rect.left - current.x) / current.zoom, y: (sy - rect.top - current.y) / current.zoom };
  };

  /** 将全部内容置于可视范围中央；旧像素坐标场景加载后也能立即恢复可见。 */
  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const pts = COMPONENTS.map((c) => positions[c.id] ?? { x: c.x, y: c.y });
    meters.forEach((m) => pts.push(m.presetVb ?? m.position));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(0, ...xs) - 80;
    const minY = Math.min(0, ...ys) - 60;
    const maxX = Math.max(VIEW_W, ...xs.map((x) => x + 210)) + 80;
    const maxY = Math.max(VIEW_H, ...ys.map((y) => y + 280)) + 60;
    const zoom = Math.max(0.25, Math.min(1.25, Math.min((rect.width - 48) / (maxX - minX), (rect.height - 48) / (maxY - minY))));
    setView({ x: (rect.width - (minX + maxX) * zoom) / 2, y: (rect.height - (minY + maxY) * zoom) / 2, zoom });
  }, [positions, meters]);

  useEffect(() => {
    if (!fittedRef.current && canvasSize.w > 0 && canvasSize.h > 0) {
      fittedRef.current = true;
      fitView();
    }
  }, [canvasSize, fitView]);

  useEffect(() => {
    const onFit = () => fitView();
    window.addEventListener('canvas-fit', onFit);
    return () => window.removeEventListener('canvas-fit', onFit);
  }, [fitView]);

  /** 同步所有部件卡片 + 仪表卡片的画布像素 rect 到 store（供 updateCableEnd 兑底用） */
  const syncCardPositionsToStore = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    const positions: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [id, card] of Object.entries(cardRefs.current)) {
      if (!card) continue;
      const rect = card.getBoundingClientRect();
      const current = viewRef.current;
      positions[id] = {
        x: (rect.left - canvasRect.left - current.x) / current.zoom,
        y: (rect.top - canvasRect.top - current.y) / current.zoom,
        w: rect.width / current.zoom,
        h: rect.height / current.zoom,
      };
    }
    setCardPositions(positions);
  }, [setCardPositions]);

  /**
   * 锚点 → 画布内像素坐标。
   *  - "cable:{id}.{from|to}" → 递归到组件 / 仪表锚点
   *  - "{compId|meterId}.{top|bottom|left|right}" → 对应卡片 4 边中点
   *  cycle 防护：visited Set 防递归成环。命中 cycle 时 fallback 到上游 cable 的 floatingFrom/floatingTo。
   */
  const getAnchorCanvasPos = (
    anchorId: string,
    options?: { visitedCables?: Set<string> },
  ): { x: number; y: number } | null => {
    const visitedCables = options?.visitedCables ?? new Set<string>();

    // 线缆端点格式 "cable:{cableId}.{from|to}"：递归解析
    if (anchorId.startsWith('cable:')) {
      const cables = useSimStore.getState().cables;
      const m = anchorId.match(/^cable:(.+)\.(from|to)$/);
      if (!m) return null;
      const cableId = m[1];
      const cable = cables.find((c) => c.id === cableId);
      if (!cable || cable.segments.length === 0) return null;
      const isFrom = m[2] === 'from';
      if (visitedCables.has(cableId)) {
        console.warn('[getAnchorCanvasPos] cycle detected:', cableId);
        return isFrom ? cable.floatingFrom ?? null : cable.floatingTo ?? null;
      }
      const segIdx = isFrom ? 0 : cable.segments.length - 1;
      const innerAnchor = isFrom ? cable.segments[segIdx].fromAnchorId
                                : cable.segments[segIdx].toAnchorId;
      if (innerAnchor) {
        const nextVisitedCables = new Set(visitedCables);
        nextVisitedCables.add(cableId);
        return getAnchorCanvasPos(innerAnchor, { visitedCables: nextVisitedCables });
      }
      return isFrom ? cable.floatingFrom ?? null : cable.floatingTo ?? null;
    }
    // 组件锚点 / 仪表卡片锚点 格式 "{id}.{top|bottom|left|right}"
    const m = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
    if (!m) return null;
    const cardId = m[1];
    const side = m[2];
    const card = cardRefs.current[cardId];
    if (!card) return null;
    const cardRect = card.getBoundingClientRect();
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!canvasRect) return null;
    const current = viewRef.current;
    const cx = (cardRect.left - canvasRect.left - current.x) / current.zoom;
    const cy = (cardRect.top - canvasRect.top - current.y) / current.zoom;
    const cw = cardRect.width / current.zoom;
    const ch = cardRect.height / current.zoom;
    switch (side) {
      case 'top':    return { x: cx + cw / 2, y: cy };
      case 'bottom': return { x: cx + cw / 2, y: cy + ch };
      case 'left':   return { x: cx,           y: cy + ch / 2 };
      case 'right':  return { x: cx + cw,      y: cy + ch / 2 };
    }
    return null;
  };

  /** 枚举所有可吸附锚点（组件 + 仪表卡片 + 线缆端点） */
  const listAllSnapPoints = (
    excludeCableId?: string,
  ): Array<{ id: string; pos: { x: number; y: number } }> => {
    const out: Array<{ id: string; pos: { x: number; y: number } }> = [];
    // 1) 组件锚点
    for (const c of COMPONENTS) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const p = getAnchorCanvasPos(`${c.id}.${side}`);
        if (p) out.push({ id: `${c.id}.${side}`, pos: p });
      }
    }
    // 2) 仪表卡片锚点
    const liveMeters = useSimStore.getState().meters;
    for (const m of liveMeters) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const p = getAnchorCanvasPos(`${m.id}.${side}`);
        if (p) out.push({ id: `${m.id}.${side}`, pos: p });
      }
    }
    // 3) 线缆端点（排除指定 cable）
    const cables = useSimStore.getState().cables;
    for (const cable of cables) {
      if (excludeCableId && cable.id === excludeCableId) continue;
      if (cable.segments.length === 0) continue;
      for (const end of ['from', 'to'] as const) {
        const id = `cable:${cable.id}.${end}`;
        const p = getAnchorCanvasPos(id);
        if (p) out.push({ id, pos: p });
      }
    }
    return out;
  };

  /** 找最近锚点（≤ 8px，canvas 像素坐标） */
  const findNearestAnchorPx = (
    pt: { x: number; y: number },
    excludeCableId?: string,
  ): { id: string; pos: { x: number; y: number } } | null => {
    let best: { id: string; pos: { x: number; y: number } } | null = null;
    let bestDist = 8;
    for (const s of listAllSnapPoints(excludeCableId)) {
      const d = Math.hypot(s.pos.x - pt.x, s.pos.y - pt.y);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  };

  /** HTML5 drop：调色板 → 画布（线缆 / 仪表） */
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const drop = readDropType(e);
    if (!drop) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    if (!pt) return;

    syncCardPositionsToStore();

    if (drop.kind === 'cable') {
      const nearest = findNearestAnchorPx(pt);
      const fromAnchorId = nearest?.id ?? null;
      const cableId = addCable(
        drop.type as any,
        fromAnchorId,
        null,
        fromAnchorId ? null : pt,
        pt
      );
      selectCable(cableId);
      // I3: drop 后清掉 cableDrag / draggingCardId，让用户手动点击浮动端点启动拖动。
      // 避免之前默认启动 to 端 drag session 时，若用户不再操作鼠标就保持
      // `dragging-cable` class + snap highlight 永远残留。
      setCableDrag(null);
      setDraggingCardId(null);
    } else if (drop.kind === 'meter') {
      // 仪表卡片中心对准落点
      const CARD_W = 140;
      const CARD_H = 200;
      const meterId = addMeter(drop.type as MeterType, {
        x: pt.x - CARD_W / 2,
        y: pt.y - CARD_H / 2,
      });
      selectMeter(meterId);
    }
  };

  // 背景点击 → 取消所有选中
  const handleCanvasClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const cls = target.classList;
    if (cls?.contains('canvas-bg') || cls?.contains('canvas-area')) {
      selectComponent(null);
      selectCable(null);
      selectMeter(null);
    }
  };

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('canvas-area') && !target.classList.contains('canvas-bg')) return;
    const start = { x: e.clientX, y: e.clientY, view: viewRef.current };
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.hypot(dx, dy) > 3) moved = true;
      setView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (moved) cardDownRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const old = viewRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const zoom = Math.max(0.2, Math.min(2.5, old.zoom * factor));
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = (sx - old.x) / old.zoom;
    const wy = (sy - old.y) / old.zoom;
    setView({ zoom, x: sx - wx * zoom, y: sy - wy * zoom });
  };

  const zoomAtCenter = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const old = viewRef.current;
    const zoom = Math.max(0.2, Math.min(2.5, old.zoom * factor));
    const sx = rect.width / 2;
    const sy = rect.height / 2;
    setView({ zoom, x: sx - ((sx - old.x) / old.zoom) * zoom, y: sy - ((sy - old.y) / old.zoom) * zoom });
  };

  const isDraggingCable = cableDrag != null;

  return (
    <div
      className={`canvas-area ${editMode ? 'edit-mode' : ''} ${isDraggingOver ? 'drag-over' : ''}`}
      ref={canvasRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleCanvasClick}
      onMouseDown={startPan}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).classList.contains('canvas-area') || (e.target as HTMLElement).classList.contains('canvas-bg')) fitView(); }}
      onWheel={handleWheel}
    >
      <div className="canvas-bg" style={state.showGrid ? { backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` } : undefined} />
      <div className="world-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>

      {/* 12 固定部件卡片（绝对定位，任何时候可拖） */}
      {COMPONENTS.map((comp) => {
        // positions[id] 为 CSS 像素（拖拽直接写入），defaultPositions 已预缩放为 CSS px
        const pos = positions[comp.id] ?? defaultPositions[comp.id];
        return (
          <div
            key={comp.id}
            className={`component-card ${draggingCardId === comp.id ? 'dragging' : ''}`}
            ref={(el) => { cardRefs.current[comp.id] = el; }}
            style={{ position: 'absolute', left: pos.x, top: pos.y, width: 'clamp(120px, 11vw, 180px)' }}
            onMouseDown={(e) => {
              // I1: editMode 关闭时卡片锁定，不能被拖动（点击仍透传到 SVG 触发状态切换）
              if (!state.editMode) return;
              e.preventDefault();
              e.stopPropagation();
              selectComponent(comp.id);
              setDraggingCardId(comp.id);
              setStoreDragging(comp.id);
              startDragCard(e, comp.id, pos, (p) => setPosition(comp.id, p.x, p.y));
            }}
            data-component-id={comp.id}
          >
            <h3 className="card-title">{comp.name}</h3>
            <div className="card-svg-mount">
              <ComponentSlot
                comp={comp}
                state={state}
                onClick={handleComponentClick}
                onDoubleClick={handleSvgDoubleClick}
              />
            </div>
          </div>
        );
      })}

      {/* 仪表卡片（预置 + 用户拖出，与部件卡片同结构，4 边可作线缆端点） */}
      {meters.map((m) => {
        const meta = METER_PALETTE.find((p) => p.type === m.type);
        const isSelected = selectedMeter === m.id;
        // - 预置仪表：m.presetVb 有值（viewBox 1800×1100）→ × scaleX/scaleY
        // - 用户拖出：m.presetVb 为 undefined（moveMeter 已清），m.position 是 CSS px
        const pos = m.presetVb ?? m.position;
        return (
          <div
            key={m.id}
            className={`component-card meter-card ${draggingCardId === m.id ? 'dragging' : ''} ${isSelected ? 'selected' : ''}`}
            ref={(el) => { cardRefs.current[m.id] = el; }}
            style={{ position: 'absolute', left: pos.x, top: pos.y, width: 'clamp(80px, 7vw, 110px)' }}
            onMouseDown={(e) => {
              // I1: editMode 关闭时仪表卡片锁定
              if (!state.editMode) return;
              e.preventDefault();
              e.stopPropagation();
              selectMeter(m.id);
              setDraggingCardId(m.id);
              setStoreDragging(m.id);
              startDragCard(e, m.id, pos, (p) => moveMeter(m.id, p));
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // 预置/拖出仪表：打开对应仪表类型详情（m.type → 'power-meter'/'temp-sensor'）
              setDetailCompId(m.type);
            }}
            data-component-id={m.id}
          >
            <h3 className="card-title">{m.bind ? METER_BIND_LABELS[m.bind] : (meta?.label ?? m.type)}</h3>
            <div className="card-svg-mount">
              <MeterSlot meter={m} state={state} />
            </div>
          </div>
        );
      })}

      {/* 线缆 SVG 覆盖层（绝对定位，覆盖在卡片之上） */}
      <svg
        ref={cableOverlayRef}
        className={`cable-overlay ${isDraggingCable ? 'dragging-cable' : ''}`}
        onClick={(e) => {
          if (e.target === cableOverlayRef.current) {
            selectComponent(null);
            selectCable(null);
            selectMeter(null);
          }
        }}
      >
        <CableOverlay
          getAnchorPos={getAnchorCanvasPos}
          canvasRef={canvasRef}
          cableOverlayRef={cableOverlayRef}
          syncCardPositionsToStore={syncCardPositionsToStore}
          cancelDragRef={cancelDragRef}
          toWorld={screenToCanvas}
        />
      </svg>

      {/* M1.5 Round 3: 温度传感器指针覆盖层（每个 temp-sensor 仪表各一个；独立 SVG + setInterval 局部旋转） */}
      {meters.filter((m) => m.type === 'temp-sensor').map((m) => (
        <TsPointer key={`tsptr-${m.id}`} meter={m} />
      ))}

      </div>
      <div className="canvas-nav" style={{ right: state.rightPanelOpen ? 350 : 18 }} onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomAtCenter(1 / 1.2)} title="缩小">−</button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => zoomAtCenter(1.2)} title="放大">+</button>
        <button type="button" className="fit" onClick={fitView} title="居中并适配全部内容">⌖</button>
      </div>
      <ComponentDetail compId={detailCompId} onClose={() => setDetailCompId(null)} />
    </div>
  );
}

/** 线缆 SVG 覆盖层（在主 SVG 内绘制所有 cable + 删除按钮），使用画布像素坐标 */
function CableOverlay({
  getAnchorPos,
  canvasRef,
  cableOverlayRef,
  syncCardPositionsToStore,
  cancelDragRef,
  toWorld,
}: {
  getAnchorPos: (anchorId: string) => { x: number; y: number } | null;
  canvasRef: React.MutableRefObject<HTMLDivElement | null>;
  cableOverlayRef: React.MutableRefObject<SVGSVGElement | null>;
  syncCardPositionsToStore: () => void;
  cancelDragRef: React.MutableRefObject<(() => void) | null>;
  toWorld: (screenX: number, screenY: number) => { x: number; y: number } | null;
}) {
  const cables = useSimStore((s) => s.cables);
  const selectedCable = useSimStore((s) => s.selectedCable);
  const selectedMeter = useSimStore((s) => s.selectedMeter);
  const removeCable = useSimStore((s) => s.removeCable);
  const removeMeter = useSimStore((s) => s.removeMeter);
  const selectCable = useSimStore((s) => s.selectCable);
  const updateCableEnd = useSimStore((s) => s.updateCableEnd);
  const setCableFloating = useSimStore((s) => s.setCableFloating);
  const setCableDrag = useSimStore((s) => s.setCableDrag);
  const cableDrag = useSimStore((s) => s.cableDrag);
  const state = useSimStore((s) => s);
  const particleLayerRef = useRef<SVGGElement>(null);

  // 把 store 里的 cables 在传给粒子 hook 前把 floatingFrom/To 转成 CSS px
  // （hook 内部把点直接放进 SVG cx/cy，SVG viewBox 是 CSS px 空间）
  // revert：floatingFrom/To 本身就是 CSS px，直接透传即可
  const cablesForParticles = useMemo(
    () => cables,
    [cables],
  );
  const particleState = useMemo<SimulationState>(
    () => ({ ...state, cables: cablesForParticles as any }),
    [state, cablesForParticles],
  );

  useParticleAnimation(particleLayerRef, particleState, getAnchorPos);

  const findNearestWorld = (pt: { x: number; y: number }, excludeCableId?: string) => {
    let best: { id: string; pos: { x: number; y: number } } | null = null;
    let bestDist = 8;
    // 组件锚点
    for (const c of COMPONENTS) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const p = getAnchorPos(`${c.id}.${side}`);
        if (!p) continue;
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestDist) { bestDist = d; best = { id: `${c.id}.${side}`, pos: p }; }
      }
    }
    // 仪表卡片锚点
    const liveMeters = useSimStore.getState().meters;
    for (const m of liveMeters) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const p = getAnchorPos(`${m.id}.${side}`);
        if (!p) continue;
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestDist) { bestDist = d; best = { id: `${m.id}.${side}`, pos: p }; }
      }
    }
    // 线缆端点（排除自己这条 cable）
    for (const cable of cables) {
      if (excludeCableId && cable.id === excludeCableId) continue;
      if (cable.segments.length === 0) continue;
      for (const end of ['from', 'to'] as const) {
        const id = `cable:${cable.id}.${end}`;
        const p = getAnchorPos(id);
        if (!p) continue;
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestDist) { bestDist = d; best = { id, pos: p }; }
      }
    }
    return best;
  };

  // 拖动端点（联动 owner：链式 cable 共享端点时上游跟随）
  const startDragEnd = (cableId: string, end: 'from' | 'to', e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectCable(cableId);
    const svg = cableOverlayRef.current;
    if (!svg) return;
    // ★ drag 开始时捕获 owner（onMove 全程不变）
    const owner = findOwnerEnd(cableId, end);

    // I2: cancelled 标志用于 Esc 取消拖动。onMove / onUp 在 cancelled=true 时 noop。
    let cancelled = false;
    cancelDragRef.current = () => { cancelled = true; };

    const onMove = (ev: MouseEvent) => {
      if (cancelled) return;
      const pt = toWorld(ev.clientX, ev.clientY);
      if (!pt) return;
      setCableFloating(cableId, end, pt);
      // ★ 联动 owner：owner 不同于当前端点时才显式 setCableFloating
      // （owner 即当前端点时不做重复调用）
      if (owner && (owner.cableId !== cableId || owner.end !== end)) {
        setCableFloating(owner.cableId, owner.end, pt);
      }
      // 排除自身另一端，避免 A.to 误吸附 A.from
      const snap = findNearestWorld(pt, cableId);
      setCableDrag({ cableId, end, pos: pt, snapAnchorId: snap?.id ?? null });
    };
    const onUp = () => {
      if (!cancelled) {
        const finalDrag = useSimStore.getState().cableDrag;
        // ★ 仅当 cableDrag 属于本次会话时才提交 anchor；否则保持原状，
        // 避免 mousedown-立即-mouseup 时读取陈旧 cableDrag 推 cable 进入不一致态
        if (finalDrag?.cableId === cableId && finalDrag?.end === end) {
          const finalAnchor = finalDrag.snapAnchorId ?? null;
          // ★ R-B: 提交前同步 cardPositions 到 store，让 updateCableEnd 兑底能拿到最新位置
          syncCardPositionsToStore();
          updateCableEnd(cableId, end, finalAnchor);
        }
      }
      cancelDragRef.current = null;
      setCableDrag(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <>
      {cables.map((cable) => {
        const color = LINE_COLORS[cable.kind];
        const isSelected = selectedCable === cable.id;
        const segs = cable.segments;
        const fromAnchorId = segs[0]?.fromAnchorId ?? '';
        const toAnchorId = segs[segs.length - 1]?.toAnchorId ?? '';
        const fromResolved = fromAnchorId ? getAnchorPos(fromAnchorId) : null;
        const toResolved = toAnchorId ? getAnchorPos(toAnchorId) : null;
        // floatingFrom/To 来自 store（CSS px 坐标），直接使用
        const floatingFromCss = cable.floatingFrom;
        const floatingToCss = cable.floatingTo;
        const fromPos = fromResolved ?? floatingFromCss ?? null;
        const toPos = toResolved ?? floatingToCss ?? null;

        return (
          <g key={cable.id} className={`editable-cable ${isSelected ? 'selected' : ''}`}>
            {/* 段渲染 */}
            {segs.map((seg, i) => {
              const segFromDefault = seg.fromAnchorId ? getAnchorPos(seg.fromAnchorId) : null;
              const segToDefault = seg.toAnchorId ? getAnchorPos(seg.toAnchorId) : null;
              let p1 = segFromDefault;
              let p2 = segToDefault;
              if (i === 0 && !p1) p1 = floatingFromCss ?? null;
              if (i === segs.length - 1 && !p2) p2 = floatingToCss ?? null;
              if (!p1 || !p2) return null;

              // ★ 浮动端若被其它 cable 引用（cable-cable 连接），视为"已锚定"
              const fromRefIsReferenced = !segFromDefault && i === 0 && cables.some((c) =>
                c.id !== cable.id &&
                c.segments.some((s) =>
                  s.fromAnchorId === `cable:${cable.id}.from` || s.toAnchorId === `cable:${cable.id}.from`
                )
              );
              const toRefIsReferenced = !segToDefault && i === segs.length - 1 && cables.some((c) =>
                c.id !== cable.id &&
                c.segments.some((s) =>
                  s.fromAnchorId === `cable:${cable.id}.to` || s.toAnchorId === `cable:${cable.id}.to`
                )
              );

              // ★ 主修复：被引用算"已解析"
              const isFromResolvedEffective = !!segFromDefault || fromRefIsReferenced;
              const isToResolvedEffective   = !!segToDefault   || toRefIsReferenced;
              const isFloating = !isFromResolvedEffective || !isToResolvedEffective;
              return (
                <line
                  key={`seg-${cable.id}-${i}`}
                  x1={p1.x} y1={p1.y}
                  x2={p2.x} y2={p2.y}
                  stroke={isSelected ? '#FCD34D' : color}
                  strokeWidth={isSelected ? 5 : 4}
                  strokeLinecap="round"
                  strokeDasharray={isFloating ? '10 6' : undefined}
                  opacity={isSelected ? 0.95 : isFloating ? 0.5 : 0.75}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    selectCable(isSelected ? null : cable.id);
                  }}
                />
              );
            })}
            {/* 端点手柄 */}
            {fromPos && fromResolved && (
              <g>
                <circle cx={fromPos.x} cy={fromPos.y} r={10}
                  fill="none" stroke={color} strokeWidth={1} opacity={0.4} pointerEvents="none" />
                <circle cx={fromPos.x} cy={fromPos.y} r={6}
                  fill={color} stroke="white" strokeWidth="2"
                  style={{ cursor: 'move' }}
                  onMouseDown={(e) => startDragEnd(cable.id, 'from', e)}
                />
              </g>
            )}
            {toPos && toResolved && (
              <g>
                <circle cx={toPos.x} cy={toPos.y} r={10}
                  fill="none" stroke={color} strokeWidth={1} opacity={0.4} pointerEvents="none" />
                <circle cx={toPos.x} cy={toPos.y} r={6}
                  fill={color} stroke="white" strokeWidth="2"
                  style={{ cursor: 'move' }}
                  onMouseDown={(e) => startDragEnd(cable.id, 'to', e)}
                />
              </g>
            )}
            {/* 浮动端点（灰色虚线圆点） */}
            {!fromResolved && fromPos && (
              <g>
                <circle cx={fromPos.x} cy={fromPos.y} r={10}
                  fill="none" stroke="#94a3b8" strokeWidth={1} opacity={0.4} pointerEvents="none" />
                <circle cx={fromPos.x} cy={fromPos.y} r={6}
                  fill="#94a3b8" stroke="white" strokeWidth="2"
                  strokeDasharray="3 2"
                  style={{ cursor: 'move' }}
                  onMouseDown={(e) => startDragEnd(cable.id, 'from', e)}
                />
              </g>
            )}
            {!toResolved && toPos && (
              <g>
                <circle cx={toPos.x} cy={toPos.y} r={10}
                  fill="none" stroke="#94a3b8" strokeWidth={1} opacity={0.4} pointerEvents="none" />
                <circle cx={toPos.x} cy={toPos.y} r={6}
                  fill="#94a3b8" stroke="white" strokeWidth="2"
                  strokeDasharray="3 2"
                  style={{ cursor: 'move' }}
                  onMouseDown={(e) => startDragEnd(cable.id, 'to', e)}
                />
              </g>
            )}
          </g>
        );
      })}
      <g ref={particleLayerRef} className="particle-layer" />
      {/* 拖动端点时高亮最近锚点 */}
      {cableDrag?.snapAnchorId && (() => {
        const p = getAnchorPos(cableDrag.snapAnchorId);
        if (!p) return null;
        return (
          <rect x={p.x - 7} y={p.y - 7} width={14} height={14}
            fill="none" stroke="#22C55E" strokeWidth={2} rx={2}
            pointerEvents="none" />
        );
      })()}
      {/* 删除按钮（线缆选中时） */}
      {selectedCable && (
        <g className="delete-btn" style={{ cursor: 'pointer' }} onClick={(e) => {
          e.stopPropagation();
          removeCable(selectedCable);
          selectCable(null);
        }}>
          <rect x={10} y={10} width={110} height={26} rx={4} fill="#ef4444" opacity={0.95} />
          <text x={65} y={28} textAnchor="middle" fill="white" fontSize="13" fontWeight="bold">✕ 删除线缆</text>
        </g>
      )}
      {/* 删除按钮（仪表选中时） */}
      {selectedMeter && (
        <g className="delete-btn" style={{ cursor: 'pointer' }} onClick={(e) => {
          e.stopPropagation();
          removeMeter(selectedMeter);
          selectCable(null);
        }}>
          <rect x={10} y={10} width={110} height={26} rx={4} fill="#ef4444" opacity={0.95} />
          <text x={65} y={28} textAnchor="middle" fill="white" fontSize="13" fontWeight="bold">✕ 删除仪表</text>
        </g>
      )}
    </>
  );
}
