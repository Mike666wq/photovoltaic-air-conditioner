import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMPONENTS, SVG_FILES, type ComponentDef } from '../data/components';
import { useSimStore, type SimulationState } from '../store/simulation';
import { fetchSvg, injectAll, injectComponentRootState } from '../injector/injector';
import { LINE_COLORS, type Cable } from '../data/cables';
import { METER_PALETTE, METER_FILES, type MeterType } from '../data/palettes';
import type { MeterInstance } from '../data/meters';
import { METER_BIND_LABELS } from '../data/meters';
import { buildMeterInjectData, buildPcmInjectData, readCell } from '../services/meterInject';
import { readDropType } from './PalettePanel';
import { PARTICLE_STYLE, useParticleAnimation } from '../hooks/useParticleAnimation';
import { usePvSunAnimation } from '../hooks/usePvSunAnimation';
import { useTransientSpark } from '../hooks/useTransientSpark';
import { TsPointer } from './TsPointer';
import { ComponentDetail } from './ComponentDetail';
import { useAnalysisStore } from '../store/analysis';
import {
  alignRects, autoAlignRects, computeObjectSnap, distributeRects, tidyRects,
  type AlignmentConstraint, type AlignmentGuide, type AlignCommand, type Point, type WorldRect,
} from '../engine/alignment';
import { pointsToSvg, resolveCableRoutes, type ResolvedCablePath } from '../engine/orthogonalRouter';
import {
  boundsOfRectsAndPoints, canvasInsets, cardWorldRect, COMPONENT_WORLD_SIZE,
  METER_WORLD_SIZE, portPoint,
} from '../engine/canvasGeometry';
import {
  deriveInverterMode,
  deriveSelectedPcmVisual,
  deriveStaticBatteryMode,
  fanSpeedLabel,
} from '../engine/schematicControl';

const CLICKABLE = new Set([
  'pv-array', 'combiner-box', 'grid', 'grid-switch', 'heat-pump',
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

function buildInjectData(rawState: SimulationState) {
  const hasDataSession = rawState.controlMode === 'replay' && rawState.playbackSnapshot != null;
  const statusUnavailable = (key: keyof NonNullable<SimulationState['playbackSnapshot']>['statusAvailability']) =>
    rawState.playbackSnapshot != null && rawState.playbackSnapshot.statusAvailability[key] !== true;
  const sampledNumber = <K extends keyof Pick<SimulationState,
    'pv_power' | 'pv_sun' | 'bat_soc' | 'hp_temp' | 'hp_power' | 'tank_temp' |
    'tank_volume' | 'tank_flow' | 'pump_flow' | 'at_temp' | 'at_fan_speed' |
    'pcm_temp' | 'load_power_kw' | 'battery_power_kw' | 'pl_flow' | 'rl_flow' | 'wl_flow'
  >>(key: K): SimulationState[K] => (
    !hasDataSession || rawState.injectionFieldAvailability[key] === true ? rawState[key] : 0
  );
  // 数据会话中，当前时间轴未提供的数值统一归零用于视觉派生；文字通道再显示“—”。
  // 不修改 store 原值，只防止其它来源上一帧的数值泄漏到当前模式。
  const state: SimulationState = hasDataSession ? {
    ...rawState,
    pv_power: sampledNumber('pv_power'), pv_sun: sampledNumber('pv_sun'),
    bat_soc: sampledNumber('bat_soc'), hp_temp: sampledNumber('hp_temp'), hp_power: sampledNumber('hp_power'),
    tank_temp: sampledNumber('tank_temp'), tank_volume: sampledNumber('tank_volume'), tank_flow: sampledNumber('tank_flow'),
    pump_flow: sampledNumber('pump_flow'), at_temp: sampledNumber('at_temp'), at_fan_speed: sampledNumber('at_fan_speed'),
    pcm_temp: sampledNumber('pcm_temp'), load_power_kw: sampledNumber('load_power_kw'), battery_power_kw: sampledNumber('battery_power_kw'),
    pl_flow: sampledNumber('pl_flow'), rl_flow: sampledNumber('rl_flow'), wl_flow: sampledNumber('wl_flow'),
    // 未采集状态不等于明确关闭：保留场景状态，文字通道继续显示“数据未提供”。
    pv_on: rawState.pv_on,
    cb_connected: rawState.cb_connected,
    gs_on: rawState.gs_on,
    grid_online: rawState.grid_online,
    hp_on: rawState.hp_on,
    pump_on: rawState.pump_on,
    load_on: rawState.load_on,
    at_mode: rawState.at_mode,
  } : rawState;
  const effectivePvOn = state.controlMode === 'replay' ? state.pv_on : state.pv_on || state.pv_power > 0.01;
  const isUnavailable = (key: keyof typeof rawState.injectionFieldAvailability) =>
    hasDataSession && rawState.injectionFieldAvailability[key] !== true;
  // 部件容量标签（从 data/components.ts 取 spec）
  const capOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.spec ?? '';
  // PCM 视觉派生：采集会话优先使用当前选中的 T0/T1，而不只是切换 LCD 文字。
  const pcmData = buildPcmInjectData(rawState);
  const pcm = deriveSelectedPcmVisual(state, pcmData.liveTemp);
  const ratingOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.rating ?? '';

  // XLSX 电池字段读取（电压/电流/SOC；剩余容量无 UI 消费，不做直读）
  const batV = readCell(rawState, '电压(V)');
  const batA = readCell(rawState, '电流(A)');
  const batSocX = readCell(rawState, 'SOC(%)');
  const hasBmsSession = state.injectionSources.some((source) => source.role === 'battery-bms');
  const currentConvention = useAnalysisStore.getState().batteryCurrentConvention;
  const batSoc = batSocX ?? (hasDataSession ? null : state.bat_soc);
  const batteryDirection = batA == null || currentConvention === 'unknown'
    ? 'unknown'
    : batA === 0
      ? 'idle'
      : currentConvention === 'positive-charge'
        ? (batA > 0 ? 'charging' : 'discharging')
        : (batA > 0 ? 'discharging' : 'charging');
  const staticBatteryMode = deriveStaticBatteryMode(state.battery_power_kw);
  const inverterMode = deriveInverterMode(state);

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
    pv_power: isUnavailable('pv_power') ? '—' : state.pv_power.toFixed(2) + ' kW',
    pv_progress: isUnavailable('pv_power') ? '—' : Math.round(state.pv_power / 5 * 100) + '%',
    pv_capacity: capOf('pv-array'),
    sun_intensity: Math.round(state.pv_sun * 100) + '%',
    // === IV ===
    iv_capacity: capOf('inverter'),
    iv_dc_voltage: '380 V',
    iv_dc_current: isUnavailable('pv_power') ? '—' : (state.pv_power / 0.38).toFixed(1) + ' A',
    iv_ac_voltage: '220 V',
    iv_ac_freq: '50 Hz',
    // === Bat ===
    bat_soc: batSoc == null ? '—' : Math.round(batSoc) + '%',
    // BMS 电流方向必须由数据源配置确认；未知时不根据正负号猜测充放电。
    bat_status_text: batA != null
      ? (batteryDirection === 'charging' ? '充电' : batteryDirection === 'discharging' ? '放电' : batteryDirection === 'idle' ? '待机' : '方向待确认')
      : hasDataSession ? '数据不可用' : (staticBatteryMode === 'charging' ? '充电' : staticBatteryMode === 'discharging' ? '放电' : '待机'),
    bat_status_label: batA != null
      ? (batteryDirection === 'charging' ? 'CHG' : batteryDirection === 'discharging' ? 'DCH' : batteryDirection === 'idle' ? 'IDLE' : 'UNSET')
      : hasDataSession ? 'N/A' : (staticBatteryMode === 'charging' ? 'CHG' : staticBatteryMode === 'discharging' ? 'DCH' : 'IDLE'),
    bat_capacity: capOf('battery'),
    bat_label: ratingOf('battery'),
    bat_voltage: batV != null ? batV.toFixed(1) : (hasBmsSession ? '—' : staticBatteryMode !== 'idle' ? '53.0' : '—'),
    bat_current: batA != null ? batA.toFixed(1) : (hasBmsSession ? '—' : staticBatteryMode !== 'idle' ? (state.battery_power_kw / 0.053).toFixed(1) : '—'),
    // === CB ===
    cb_status_text: statusUnavailable('cb_connected') ? '数据未提供' : state.cb_connected ? '合闸' : '分闸',
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
    gs_status_text: statusUnavailable('gs_on') ? '● 未知' : state.gs_on ? '● 合闸' : '● 分闸',
    gs_label_on: 'ON',
    gs_label_off: 'OFF',
    gs_handle: state.gs_on ? 'ON' : 'OFF',
    // === HP ===
    hp_status_text: isUnavailable('hp_temp') && isUnavailable('hp_power') ? '数据不可用' : state.hp_on ? '运行' : '待机',
    hp_temp: isUnavailable('hp_temp') ? '—' : Math.round(state.hp_temp) + '℃',
    hp_power: isUnavailable('hp_power') ? '—' : state.hp_power.toFixed(1) + ' kW',
    hp_capacity: capOf('heat-pump'),
    hp_cop: 'COP 3.8',
    hp_code: 'R32',
    hp_mode: state.at_mode === 'cool' ? 'COOL' : state.at_mode === 'heat' ? 'HEAT' : 'OFF',
    hp_mode_icon: state.at_mode === 'cool' ? '❄' : state.at_mode === 'heat' ? '♨' : '—',
    // === Tank ===
    tank_temp: isUnavailable('tank_temp') ? '—' : Math.round(state.tank_temp) + '℃',
    tank_volume: isUnavailable('tank_volume') ? '—' : Math.round(state.tank_volume) + '%',
    tank_flow: isUnavailable('tank_flow') ? '—' : state.tank_flow.toFixed(1) + ' m³/h',
    tank_capacity: capOf('tank'),
    tank_threshold: isUnavailable('tank_temp') ? '—' : state.tank_temp > 85 ? '>85℃' : (state.tank_temp === 85 ? '=85℃' : '≤85℃'),
    // === Pump ===
    pump_flow: isUnavailable('pump_flow') ? '—' : state.pump_flow.toFixed(1) + ' m³/h',
    pump_status_text: isUnavailable('pump_flow') ? '数据不可用' : state.pump_on ? '运行' : '停机',
    pump_capacity: capOf('pump'),
    // 当前数据源没有独立水泵电功率测点，按流量显示估算值并明确标记。
    pump_power: isUnavailable('pump_flow') ? '—' : state.pump_on ? `≈${(0.18 + state.pump_flow * 0.08).toFixed(2)}` : '0.00',
    pump_head: 'H=3m',
    pump_flow_label: isUnavailable('pump_flow') ? '—' : state.pump_flow.toFixed(1),
    // === AT ===
    at_temp: isUnavailable('at_temp') ? '—' : Math.round(state.at_temp) + '℃',
    at_status_text: statusUnavailable('at_mode') ? '数据未提供' : state.at_mode === 'cool' ? '制冷' : state.at_mode === 'heat' ? '制热' : '关机',
    at_capacity: capOf('air-terminal'),
    at_mode_label: state.at_mode === 'cool' ? '❄ 制冷' : state.at_mode === 'heat' ? '♨ 制热' : '⏻ 关机',
    at_mode: state.at_mode === 'cool' ? '❄ COOL' : state.at_mode === 'heat' ? '♨ HEAT' : 'OFF',
    at_set_temp: isUnavailable('at_temp') ? '—' : Math.round(state.at_temp) + '℃',
    at_set_label: '设定',
    at_fan_speed_label: fanSpeedLabel(state.at_fan_speed, state.at_mode),
    at_count: '3 台',
    // === Solar air cooler（独立水箱/水泵/风机，不接中央水路）===
    sac_water_level: Math.round(state.sac_water_level) + '%',
    sac_water_temp: Math.round(state.sac_water_temp) + '℃',
    sac_outlet_temp: sacState === 'on' ? Math.round(state.sac_outlet_temp) + '℃' : '--',
    sac_power: sacState === 'on' ? (0.08 + state.sac_fan_speed * 0.16).toFixed(2) + ' kW' : '0.00 kW',
    // === PCM ===（T0/T1 双相变材料：按 pcm_temp_select 取温度 + 数据集当前行）
    ...(() => {
      const liveTxt = isUnavailable('pcm_temp')
        ? '—'
        : pcmData.liveTemp == null
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
    load_summary: isUnavailable('load_power_kw') ? '数据不可用' : !state.load_on ? '待机 0.0 kW' : `${state.load_power_kw.toFixed(2)} kW · 客厅`,
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
    'status_glow':        ledColor(effectivePvOn ? 'on' : 'off'),
    'status_led':         ledColor(effectivePvOn ? 'on' : 'off'),
    // === CB 状态 LED（cb_led 已有；补 cb_led_glow + 报警 LED）===
    'cb_led_glow':        ledColor(state.cb_connected ? 'connected' : 'disconnected'),
    'cb_led':             ledColor(state.cb_connected ? 'connected' : 'disconnected'),
    'cb_alarm_glow':      '#FCD34D',  // 报警 LED 默认琥珀色（M1 范围：固定色，报警逻辑由 M2 引擎驱动）
    'cb_alarm_led':       '#EAB308',
    // === Grid 离线 LED（红色光晕）===
    'grid_offline_glow':  state.grid_online ? ledColor('off') : ledColor('fault'),
    'grid_offline_led':   state.grid_online ? ledColor('off') : ledColor('fault'),
    // === GS 合闸 LED（gs_led_on 已有；补 gs_led_glow_on + 分闸 LED gs_led_off）===
    'gs_led_glow_on':     ledColor(state.gs_on ? 'on' : 'off'),
    'gs_led_on':          ledColor(state.gs_on ? 'on' : 'off'),
    'gs_led_off':         state.gs_on ? '#6B7280' : '#EF4444',  // 合闸时灭/分闸时红
    // === GS 手柄球（绿=合闸/红=分闸）—— 走 geometry.fill 通道（用户归类为 geometry 而非 LED）===
    // === Inverter 4 路 LED（PV / Bat / Grid / Load）===
    'iv_pv_led_glow':     ledColor(effectivePvOn ? 'on' : 'off'),
    'iv_pv_led':          ledColor(effectivePvOn ? 'on' : 'off'),
    'iv_bat_led_glow':    ledColor(state.bat_soc > 0 ? 'on' : 'off'),
    'iv_bat_led':         ledColor(state.bat_soc > 0 ? 'on' : 'off'),
    'iv_grid_led_glow':   ledColor(state.grid_online && state.gs_on ? 'online' : 'offline'),
    'iv_grid_led':        ledColor(state.grid_online && state.gs_on ? 'online' : 'offline'),
    'iv_load_led':        ledColor(state.load_on ? 'on' : 'off'),
    // === Battery 状态 LED（bat_status_led 已有；补 bat_status_glow）===
    'bat_status_glow':    batA != null
      ? ledColor(batteryDirection === 'unknown' ? 'idle' : batteryDirection)
      : ledColor(hasDataSession ? 'idle' : staticBatteryMode),
    'bat_status_led':     batA != null
      ? ledColor(batteryDirection === 'unknown' ? 'idle' : batteryDirection)
      : ledColor(hasDataSession ? 'idle' : staticBatteryMode),
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
    // BMS 方向未知时使用中性色，避免把正负号误标为充/放电。
    'bat_status_text':  batA != null
      ? ledColor(batteryDirection === 'unknown' ? 'idle' : batteryDirection)
      : ledColor(hasDataSession ? 'idle' : staticBatteryMode),
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
    bat_charge_level: batSoc == null ? 0 : Math.round(batSoc / 10),
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
    // 只有确认 BMS 电流方向后才驱动流向动画。
    bat_anim_flow_dir: batA != null
      ? (batteryDirection === 'charging' ? 'in' : batteryDirection === 'discharging' ? 'out' : 'idle')
      : hasDataSession ? 'idle' : (staticBatteryMode === 'charging' ? 'in' : staticBatteryMode === 'discharging' ? 'out' : 'idle'),
    soc_low: batSoc != null && batSoc < 20,
  };

  const geometry: Record<string, { width?: number; height?: number; x?: number; y?: number; cx?: number; cy?: number; fill?: string }> = {
    // 蓄电池 SOC 进度条（bg=140，filled=bat_soc/100*140）
    bat_progress_bar: { width: batSoc == null ? 0 : Math.max(0, Math.min(140, (batSoc / 100) * 140)) },
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
    'iv-mode': inverterMode,
    phase: pcm.phase,
    'pump-running': state.pump_on ? 'true' : 'false',
  };

  return { fields, status, statusText, levels, animations, geometry, animStates };
}

const CLICK_ACTIONS: Record<string, (s: ReturnType<typeof useSimStore.getState>) => void> = {
  'pv-array':      (s) => s.togglePv(),
  'combiner-box':  (s) => s.toggleCb(),
  'grid':          (s) => s.toggleGridOnline(),
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
    const formatTime = () => new Date(
      state.controlMode === 'replay' && state.playbackSnapshot
        ? state.playbackSnapshot.timestamp
        : Date.now(),
    ).toLocaleTimeString('en-GB', { hour12: false });
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
  }, [comp.id, state.animationOn, state.load_on, state.controlMode, state.playbackSnapshot?.timestamp]);

  // PV 太阳 RAF 动画：只有 pv-array 槽位注册循环。
  // 此前 13 个槽各起一条 rAF，其中 12 条每帧做一次注定落空的全子树 querySelector，
  // 实测画面完全静止时主线程仍占 44%。
  usePvSunAnimation(ref, state, comp.id === 'pv-array');

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

function resolveAnchorPort(
  anchorId: string,
  cables: Cable[],
  visited = new Set<string>(),
): { id: string; side: 'top' | 'bottom' | 'left' | 'right' } | null {
  const direct = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
  if (direct && !anchorId.startsWith('cable:')) {
    return { id: direct[1], side: direct[2] as 'top' | 'bottom' | 'left' | 'right' };
  }
  const cableRef = anchorId.match(/^cable:(.+)\.(from|to)$/);
  if (!cableRef || visited.has(cableRef[1])) return null;
  const cable = cables.find((item) => item.id === cableRef[1]);
  if (!cable || cable.segments.length === 0) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(cable.id);
  const nested = cableRef[2] === 'from'
    ? cable.segments[0].fromAnchorId
    : cable.segments[cable.segments.length - 1].toAnchorId;
  return nested ? resolveAnchorPort(nested, cables, nextVisited) : null;
}

function parseDirectAnchorPort(anchorId: string) {
  if (anchorId.startsWith('cable:')) return null;
  const match = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
  if (!match) return null;
  return { id: match[1], side: match[2] as 'top' | 'bottom' | 'left' | 'right' };
}

/**
 * 只整理真正的“卡片到卡片”直连线缆。若某个卡片还连着浮动接点 / 线缆接点，
 * 就把它锁在原位，避免整理卡片后留下没有同步移动的悬空转角。
 * 完全未接线的卡片可参与重叠消解，但不会被纳入线路拓扑。
 */
function buildSafeCableLayout(cables: Cable[], rects: WorldRect[]) {
  const riskyIds = new Set<string>();
  const connectedIds = new Set<string>();
  for (const cable of cables) {
    for (const segment of cable.segments) {
      const directFrom = parseDirectAnchorPort(segment.fromAnchorId);
      const directTo = parseDirectAnchorPort(segment.toAnchorId);
      const resolvedFrom = resolveAnchorPort(segment.fromAnchorId, cables);
      const resolvedTo = resolveAnchorPort(segment.toAnchorId, cables);
      if (resolvedFrom) connectedIds.add(resolvedFrom.id);
      if (resolvedTo) connectedIds.add(resolvedTo.id);
      if (directFrom && directTo) continue;
      if (resolvedFrom) riskyIds.add(resolvedFrom.id);
      if (resolvedTo) riskyIds.add(resolvedTo.id);
    }
  }

  const constraints: AlignmentConstraint[] = [];
  for (const cable of cables) {
    for (const segment of cable.segments) {
      const from = parseDirectAnchorPort(segment.fromAnchorId);
      const to = parseDirectAnchorPort(segment.toAnchorId);
      if (!from || !to || from.id === to.id || riskyIds.has(from.id) || riskyIds.has(to.id)) continue;
      const fromHorizontal = from.side === 'left' || from.side === 'right';
      const toHorizontal = to.side === 'left' || to.side === 'right';
      const fromVertical = from.side === 'top' || from.side === 'bottom';
      const toVertical = to.side === 'top' || to.side === 'bottom';
      if (fromHorizontal && toHorizontal) constraints.push({ axis: 'y', ids: [from.id, to.id] });
      if (fromVertical && toVertical) constraints.push({ axis: 'x', ids: [from.id, to.id] });
    }
  }
  return {
    cables,
    constraints,
    overlapMovableIds: new Set(rects.map((rect) => rect.id).filter((id) => !connectedIds.has(id))),
  };
}

interface AlignUndoSnapshot {
  positions: SimulationState['positions'];
  meters: SimulationState['meters'];
  cables: SimulationState['cables'];
  cardPositions: SimulationState['cardPositions'];
}

function captureAlignSnapshot(state: SimulationState): AlignUndoSnapshot {
  return {
    positions: Object.fromEntries(Object.entries(state.positions).map(([id, point]) => [id, { ...point }])),
    meters: state.meters.map((meter) => ({
      ...meter,
      position: { ...meter.position },
      presetVb: meter.presetVb ? { ...meter.presetVb } : undefined,
    })),
    cables: state.cables.map((cable) => ({
      ...cable,
      segments: cable.segments.map((segment) => ({ ...segment })),
      floatingFrom: cable.floatingFrom ? { ...cable.floatingFrom } : cable.floatingFrom,
      floatingTo: cable.floatingTo ? { ...cable.floatingTo } : cable.floatingTo,
      manualWaypoints: cable.manualWaypoints?.map((point) => ({ ...point })),
    })),
    cardPositions: Object.fromEntries(Object.entries(state.cardPositions).map(([id, rect]) => [id, { ...rect }])),
  };
}

export function CircuitCanvas() {
  const state = useSimStore();
  const positions = useSimStore((s) => s.positions);
  const meters = useSimStore((s) => s.meters);
  const selectedCable = useSimStore((s) => s.selectedCable);
  const selectedMeter = useSimStore((s) => s.selectedMeter);
  const editMode = useSimStore((s) => s.editMode);
  const cableDrag = useSimStore((s) => s.cableDrag);
  const selectComponent = useSimStore((s) => s.selectComponent);
  const selectCable = useSimStore((s) => s.selectCable);
  const selectMeter = useSimStore((s) => s.selectMeter);
  const addCable = useSimStore((s) => s.addCable);
  const setCableDrag = useSimStore((s) => s.setCableDrag);
  const setPosition = useSimStore((s) => s.setPosition);
  const setNodePositions = useSimStore((s) => s.setNodePositions);
  const setStoreDragging = useSimStore((s) => s.setDragging);
  const addMeter = useSimStore((s) => s.addMeter);
  const moveMeter = useSimStore((s) => s.moveMeter);
  const setCardPositions = useSimStore((s) => s.setCardPositions);
  const removeCable = useSimStore((s) => s.removeCable);
  const setCableRouteMode = useSimStore((s) => s.setCableRouteMode);
  const setCableAnimation = useSimStore((s) => s.setCableAnimation);
  const setCableDirectionMode = useSimStore((s) => s.setCableDirectionMode);
  const selectedCableForToolbar = state.cables.find((cable) => cable.id === selectedCable);
  const selectedCableHasMissingEnd = selectedCableForToolbar?.segments.some((segment, index, segments) =>
    (!segment.fromAnchorId && !(index === 0 && selectedCableForToolbar.floatingFrom))
    || (!segment.toAnchorId && !(index === segments.length - 1 && selectedCableForToolbar.floatingTo))
  ) ?? false;
  const selectedCableHasFloatingEnd = Boolean(selectedCableForToolbar?.floatingFrom || selectedCableForToolbar?.floatingTo);
  const selectedFlowLabel = selectedCableHasMissingEnd ? '端点缺失'
    : selectedCableHasFloatingEnd ? '端点未吸附'
    : selectedCableForToolbar?.animationEnabled === false ? '动画已关闭'
    : '动画已开启';

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
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ start: Point; current: Point } | null>(null);
  const [alignUndoSnapshot, setAlignUndoSnapshot] = useState<AlignUndoSnapshot | null>(null);
  // M1.5 Round 13: 部件详情弹窗（双击部件触发）
  const [detailCompId, setDetailCompId] = useState<string | null>(null);
  const [detailMeterId, setDetailMeterId] = useState<string | null>(null);
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

  /** 固定世界几何是布局真值；DOM 只负责显示，不再反向决定锚点和避障范围。 */
  const getCardWorldRects = useCallback((): WorldRect[] => {
    const componentRects = COMPONENTS.map((component) => cardWorldRect(
      component.id,
      positions[component.id] ?? defaultPositions[component.id],
      meters,
    ));
    const meterRects = meters.map((meter) => cardWorldRect(
      meter.id,
      meter.presetVb ?? meter.position,
      meters,
    ));
    return [...componentRects, ...meterRects];
  }, [defaultPositions, meters, positions]);

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
  const startDragCard = (e: React.MouseEvent, id: string, dragIds: string[]) => {
    let moved = false;
    let cancelled = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const rects = getCardWorldRects();
    const dragRects = rects.filter((rect) => dragIds.includes(rect.id));
    const otherRects = rects.filter((rect) => !dragIds.includes(rect.id));
    const groupRect: WorldRect = {
      id: '__selection__',
      x: Math.min(...dragRects.map((rect) => rect.x)),
      y: Math.min(...dragRects.map((rect) => rect.y)),
      w: Math.max(...dragRects.map((rect) => rect.x + rect.w)) - Math.min(...dragRects.map((rect) => rect.x)),
      h: Math.max(...dragRects.map((rect) => rect.y + rect.h)) - Math.min(...dragRects.map((rect) => rect.y)),
    };
    const startPositions = Object.fromEntries(dragRects.map((rect) => [rect.id, { x: rect.x, y: rect.y }]));
    cardDownRef.current = { id, x: startX, y: startY };
    // 注册 cancel 回调（Esc 时调用）
    cancelDragRef.current = () => { cancelled = true; };
    const onMove = (ev: MouseEvent) => {
      if (cancelled) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      let worldDx = dx / viewRef.current.zoom;
      let worldDy = dy / viewRef.current.zoom;
      if (ev.shiftKey) {
        if (Math.abs(worldDx) >= Math.abs(worldDy)) worldDy = 0;
        else worldDx = 0;
      }
      const snap = computeObjectSnap(
        { x: groupRect.x + worldDx, y: groupRect.y + worldDy },
        { w: groupRect.w, h: groupRect.h },
        otherRects,
        {
          zoom: viewRef.current.zoom,
          gridSize: useSimStore.getState().gridSize,
          snapToGrid: useSimStore.getState().snapToGrid,
          smartGuides: useSimStore.getState().smartGuides,
          disabled: ev.altKey,
        },
      );
      const snappedDx = snap.position.x - groupRect.x;
      const snappedDy = snap.position.y - groupRect.y;
      setAlignmentGuides(snap.guides);
      setNodePositions(Object.fromEntries(dragIds.map((nodeId) => [nodeId, {
        x: startPositions[nodeId].x + snappedDx,
        y: startPositions[nodeId].y + snappedDy,
      }])));
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
      setAlignmentGuides([]);
      window.requestAnimationFrame(syncCardPositionsToStore);
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

  // 缩放必须走非 passive 的原生监听，理由见 handleWheel 上方注释。
  // handleWheel 只读 canvasRef / viewRef 与 setView，引用稳定，无需进依赖数组。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setDetailMeterId(null);
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

  /** 将真实节点/人工折点置于无遮挡安全视口中央。 */
  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const extraPoints = state.cables.flatMap((cable) => [
      ...(cable.floatingFrom ? [cable.floatingFrom] : []),
      ...(cable.floatingTo ? [cable.floatingTo] : []),
      ...(cable.manualWaypoints ?? []),
    ]);
    const bounds = boundsOfRectsAndPoints(getCardWorldRects(), extraPoints, 48);
    if (!bounds) return;
    const insets = canvasInsets(state);
    const availableWidth = Math.max(120, rect.width - insets.left - insets.right);
    const availableHeight = Math.max(120, rect.height - insets.top - insets.bottom);
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = Math.max(0.25, Math.min(1.25, Math.min(availableWidth / contentWidth, availableHeight / contentHeight)));
    setView({
      x: insets.left + (availableWidth - (bounds.minX + bounds.maxX) * zoom) / 2,
      y: insets.top + (availableHeight - (bounds.minY + bounds.maxY) * zoom) / 2,
      zoom,
    });
  }, [getCardWorldRects, state.cables, state.fullscreen, state.leftPanelOpen, state.rightPanelOpen]);

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
   * 批量对齐 / 撤销只有一次状态提交；该次 render 中线缆读取到的仍可能是提交前 DOM。
   * 等两帧让卡片样式落地后再同步几何并触发一次稳定重绘，避免线缆停在旧位置。
   */
  useEffect(() => {
    let innerFrame = 0;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(syncCardPositionsToStore);
    });
    return () => {
      window.cancelAnimationFrame(outerFrame);
      if (innerFrame) window.cancelAnimationFrame(innerFrame);
    };
  }, [meters, positions, syncCardPositionsToStore]);

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
    const rect = getCardWorldRects().find((candidate) => candidate.id === cardId);
    return rect ? portPoint(rect, side as 'top' | 'bottom' | 'left' | 'right') : null;
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

  /** 找最近锚点（屏幕半径 14px，按 zoom 换算世界距离） */
  const findNearestAnchorPx = (
    pt: { x: number; y: number },
    excludeCableId?: string,
  ): { id: string; pos: { x: number; y: number } } | null => {
    let best: { id: string; pos: { x: number; y: number } } | null = null;
    let bestDist = 14 / Math.max(0.2, viewRef.current.zoom);
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
      if (!e.shiftKey) setSelectedNodeIds(new Set());
    }
  };

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('canvas-area') && !target.classList.contains('canvas-bg')) return;
    if (state.editMode && e.shiftKey) {
      const startWorld = screenToCanvas(e.clientX, e.clientY);
      if (!startWorld) return;
      setMarquee({ start: startWorld, current: startWorld });
      const onSelectMove = (ev: MouseEvent) => {
        const current = screenToCanvas(ev.clientX, ev.clientY);
        if (current) setMarquee({ start: startWorld, current });
      };
      const onSelectUp = (ev: MouseEvent) => {
        const current = screenToCanvas(ev.clientX, ev.clientY) ?? startWorld;
        const box = {
          x: Math.min(startWorld.x, current.x), y: Math.min(startWorld.y, current.y),
          w: Math.abs(current.x - startWorld.x), h: Math.abs(current.y - startWorld.y),
        };
        const hit = getCardWorldRects().filter((rect) =>
          rect.x < box.x + box.w && rect.x + rect.w > box.x
          && rect.y < box.y + box.h && rect.y + rect.h > box.y).map((rect) => rect.id);
        setSelectedNodeIds(new Set(hit));
        setMarquee(null);
        window.removeEventListener('mousemove', onSelectMove);
        window.removeEventListener('mouseup', onSelectUp);
      };
      window.addEventListener('mousemove', onSelectMove);
      window.addEventListener('mouseup', onSelectUp);
      return;
    }
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

  // 用原生 WheelEvent 而非 React.WheelEvent：React 17+ 把 wheel 以 passive 挂在 root 上，
  // 其中的 preventDefault() 直接失效（控制台报 "Unable to preventDefault inside passive
  // event listener invocation"），结果浏览器原生缩放/滚动没有被阻止，
  // 触控板双指缩放会连页面一起缩。
  const handleWheel = (e: WheelEvent) => {
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

  const applySelectionPositions = (updates: Record<string, Point>) => {
    setNodePositions(updates);
    window.requestAnimationFrame(syncCardPositionsToStore);
  };

  const runAlign = (command: AlignCommand) => {
    applySelectionPositions(alignRects(getCardWorldRects().filter((rect) => selectedNodeIds.has(rect.id)), command));
  };

  const runDistribute = (axis: 'x' | 'y') => {
    applySelectionPositions(distributeRects(getCardWorldRects().filter((rect) => selectedNodeIds.has(rect.id)), axis));
  };

  const runTidy = () => {
    applySelectionPositions(tidyRects(getCardWorldRects().filter((rect) => selectedNodeIds.has(rect.id))));
  };

  useEffect(() => {
    const alignAll = () => {
      const rects = getCardWorldRects();
      const current = useSimStore.getState();
      const safeLayout = buildSafeCableLayout(current.cables, rects);
      const updates = autoAlignRects(rects, current.gridSize, safeLayout.constraints, {
        overlapMovableIds: safeLayout.overlapMovableIds,
      });
      const meterIds = new Set(current.meters.map((meter) => meter.id));
      setAlignUndoSnapshot(captureAlignSnapshot(current));
      useSimStore.setState((live) => ({
        positions: {
          ...live.positions,
          ...Object.fromEntries(Object.entries(updates).filter(([id]) => !meterIds.has(id))),
        },
        // 拖动过的预置仪表 presetVb 已清除，若 autoAlignRects 没给它结果就会原地保留，
        // 与同排其它仪表错开（实测 820,980 vs 910,960 两行都歪）。
        // 这里兜底做网格对齐，保证"一键整理"后所有仪表至少落在栅格上。
        meters: live.meters.map((meter) => {
          if (updates[meter.id]) {
            return { ...meter, position: updates[meter.id], presetVb: undefined };
          }
          const pos = meter.position;
          const snapped = {
            x: Math.round(pos.x / current.gridSize) * current.gridSize,
            y: Math.round(pos.y / current.gridSize) * current.gridSize,
          };
          return snapped.x === pos.x && snapped.y === pos.y
            ? meter
            : { ...meter, position: snapped, presetVb: undefined };
        }),
        cables: safeLayout.cables,
      }));
    };
    window.addEventListener('canvas-align-all', alignAll);
    return () => window.removeEventListener('canvas-align-all', alignAll);
  }, [getCardWorldRects]);

  useEffect(() => {
    const onSelectionKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'Escape') {
        setSelectedNodeIds(new Set());
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && state.editMode) {
        event.preventDefault();
        setSelectedNodeIds(new Set(getCardWorldRects().map((rect) => rect.id)));
        return;
      }
      if (!state.editMode || selectedNodeIds.size === 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? state.gridSize : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      const updates = Object.fromEntries(getCardWorldRects()
        .filter((rect) => selectedNodeIds.has(rect.id))
        .map((rect) => [rect.id, { x: rect.x + dx, y: rect.y + dy }]));
      setNodePositions(updates);
    };
    window.addEventListener('keydown', onSelectionKey);
    return () => window.removeEventListener('keydown', onSelectionKey);
  }, [getCardWorldRects, selectedNodeIds, setNodePositions, state.editMode, state.gridSize]);

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
    >
      <div className="canvas-bg" style={state.showGrid ? { backgroundSize: `${state.gridSize * 5 * view.zoom}px ${state.gridSize * 5 * view.zoom}px, ${state.gridSize * 5 * view.zoom}px ${state.gridSize * 5 * view.zoom}px, ${state.gridSize * view.zoom}px ${state.gridSize * view.zoom}px, ${state.gridSize * view.zoom}px ${state.gridSize * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` } : undefined} />
      <div className="world-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>

      {/* 12 固定部件卡片（绝对定位，任何时候可拖） */}
      {COMPONENTS.map((comp) => {
        // positions[id] 为 CSS 像素（拖拽直接写入），defaultPositions 已预缩放为 CSS px
        const pos = positions[comp.id] ?? defaultPositions[comp.id];
        return (
          <div
            key={comp.id}
            className={`component-card ${draggingCardId === comp.id ? 'dragging' : ''} ${selectedNodeIds.has(comp.id) ? 'selected' : ''}`}
            ref={(el) => { cardRefs.current[comp.id] = el; }}
            style={{ position: 'absolute', left: pos.x, top: pos.y, width: COMPONENT_WORLD_SIZE.w, height: COMPONENT_WORLD_SIZE.h }}
            onMouseDown={(e) => {
              // I1: editMode 关闭时卡片锁定，不能被拖动（点击仍透传到 SVG 触发状态切换）
              if (!state.editMode) return;
              e.preventDefault();
              e.stopPropagation();
              selectComponent(comp.id);
              const nextSelection = e.shiftKey
                ? new Set(selectedNodeIds)
                : (selectedNodeIds.has(comp.id) ? new Set(selectedNodeIds) : new Set([comp.id]));
              if (e.shiftKey) {
                if (nextSelection.has(comp.id)) nextSelection.delete(comp.id); else nextSelection.add(comp.id);
              }
              if (!nextSelection.has(comp.id)) nextSelection.add(comp.id);
              setSelectedNodeIds(nextSelection);
              setDraggingCardId(comp.id);
              setStoreDragging(comp.id);
              startDragCard(e, comp.id, [...nextSelection]);
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
        // - 预置仪表：m.presetVb 有值时直接用其世界坐标（字段名里的 Vb/scale 是历史遗留，实际不乘任何 scale）
        // - 用户拖出：m.presetVb 为 undefined（moveMeter 已清），m.position 是 CSS px
        const pos = m.presetVb ?? m.position;
        return (
          <div
            key={m.id}
            className={`component-card meter-card ${draggingCardId === m.id ? 'dragging' : ''} ${isSelected || selectedNodeIds.has(m.id) ? 'selected' : ''}`}
            ref={(el) => { cardRefs.current[m.id] = el; }}
            style={{ position: 'absolute', left: pos.x, top: pos.y, width: METER_WORLD_SIZE.w, height: METER_WORLD_SIZE.h }}
            onMouseDown={(e) => {
              // I1: editMode 关闭时仪表卡片锁定
              if (!state.editMode) return;
              e.preventDefault();
              e.stopPropagation();
              selectMeter(m.id);
              const nextSelection = e.shiftKey
                ? new Set(selectedNodeIds)
                : (selectedNodeIds.has(m.id) ? new Set(selectedNodeIds) : new Set([m.id]));
              if (e.shiftKey) {
                if (nextSelection.has(m.id)) nextSelection.delete(m.id); else nextSelection.add(m.id);
              }
              if (!nextSelection.has(m.id)) nextSelection.add(m.id);
              setSelectedNodeIds(nextSelection);
              setDraggingCardId(m.id);
              setStoreDragging(m.id);
              startDragCard(e, m.id, [...nextSelection]);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // 保留具体仪表 id，详情页按该实例的数据源绑定读取真实值。
              setDetailMeterId(m.id);
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
          getObstacles={getCardWorldRects}
          zoom={view.zoom}
        />
      </svg>

      {/* M1.5 Round 3: 温度传感器指针覆盖层（每个 temp-sensor 仪表各一个；独立 SVG + setInterval 局部旋转） */}
      {meters.filter((m) => m.type === 'temp-sensor').map((m) => (
        <TsPointer key={`tsptr-${m.id}`} meter={m} />
      ))}

      <svg className="alignment-overlay" aria-hidden="true">
        {alignmentGuides.map((guide, index) => guide.axis === 'x' ? (
          <line key={`${guide.axis}-${index}`} x1={guide.value} x2={guide.value} y1={guide.from} y2={guide.to}
            className={`alignment-guide ${guide.kind}`} vectorEffect="non-scaling-stroke" />
        ) : (
          <line key={`${guide.axis}-${index}`} y1={guide.value} y2={guide.value} x1={guide.from} x2={guide.to}
            className={`alignment-guide ${guide.kind}`} vectorEffect="non-scaling-stroke" />
        ))}
        {marquee && (
          <rect
            x={Math.min(marquee.start.x, marquee.current.x)}
            y={Math.min(marquee.start.y, marquee.current.y)}
            width={Math.abs(marquee.current.x - marquee.start.x)}
            height={Math.abs(marquee.current.y - marquee.start.y)}
            className="selection-marquee"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      </div>
      {selectedNodeIds.size > 1 && state.editMode && (
        <div className="alignment-toolbar" onMouseDown={(event) => event.stopPropagation()}>
          <span>{selectedNodeIds.size} 项</span>
          <button onClick={() => runAlign('left')} title="左对齐">左</button>
          <button onClick={() => runAlign('hcenter')} title="水平居中">中</button>
          <button onClick={() => runAlign('right')} title="右对齐">右</button>
          <button onClick={() => runAlign('top')} title="顶部对齐">上</button>
          <button onClick={() => runAlign('vcenter')} title="垂直居中">中</button>
          <button onClick={() => runAlign('bottom')} title="底部对齐">下</button>
          <button onClick={() => runDistribute('x')} title="水平均匀分布">横向分布</button>
          <button onClick={() => runDistribute('y')} title="垂直均匀分布">纵向分布</button>
          <button className="tidy" onClick={runTidy} title="保持当前行列顺序自动整理">自动整理</button>
          <button onClick={() => setSelectedNodeIds(new Set())} title="清空选择">×</button>
        </div>
      )}
      {selectedCable && (
        <div className="cable-editor-toolbar" onMouseDown={(event) => event.stopPropagation()}>
          <span>线缆</span>
          <span className={`cable-flow-status ${selectedCableForToolbar?.animationEnabled !== false && !selectedCableHasMissingEnd ? 'running' : ''}`}>{selectedFlowLabel}</span>
          <button className={(state.cables.find((cable) => cable.id === selectedCable)?.animationEnabled ?? true) ? 'active' : ''}
            onClick={() => {
              const cable = state.cables.find((item) => item.id === selectedCable);
              if (cable) setCableAnimation(selectedCable, !(cable.animationEnabled ?? true));
            }}>
            {(state.cables.find((cable) => cable.id === selectedCable)?.animationEnabled ?? true) ? '动画开' : '动画关'}
          </button>
          {(['forward', 'reverse'] as const).map((mode) => (
            <button key={mode}
              className={((state.cables.find((cable) => cable.id === selectedCable)?.directionMode === 'reverse' ? 'reverse' : 'forward') === mode) ? 'active' : ''}
              onClick={() => setCableDirectionMode(selectedCable, mode)}>
              {mode === 'forward' ? '正向→' : '反向←'}
            </button>
          ))}
          <button className={(state.cables.find((cable) => cable.id === selectedCable)?.routeMode ?? 'orthogonal-auto') === 'orthogonal-auto' ? 'active' : ''}
            onClick={() => setCableRouteMode(selectedCable, 'orthogonal-auto')}>自动布线</button>
          <button className={state.cables.find((cable) => cable.id === selectedCable)?.routeMode === 'straight' ? 'active' : ''}
            onClick={() => setCableRouteMode(selectedCable, 'straight')}>直线</button>
          <small>双击线路添加折点；双击折点删除</small>
          <button className="danger" onClick={() => { removeCable(selectedCable); selectCable(null); }}>删除</button>
        </div>
      )}
      {alignUndoSnapshot && (
        <div className="align-undo-toast" onMouseDown={(event) => event.stopPropagation()}>
          <span>已安全整理直连器件与重叠卡片</span>
          <button onClick={() => {
            useSimStore.setState({
              positions: alignUndoSnapshot.positions,
              meters: alignUndoSnapshot.meters,
              cables: alignUndoSnapshot.cables,
              cardPositions: alignUndoSnapshot.cardPositions,
            });
            setAlignUndoSnapshot(null);
          }}>撤销</button>
          <button className="dismiss" onClick={() => setAlignUndoSnapshot(null)} aria-label="关闭撤销提示">×</button>
        </div>
      )}
      <div className="canvas-nav" style={{ right: state.rightPanelOpen ? 350 : 18 }} onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomAtCenter(1 / 1.2)} title="缩小">−</button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => zoomAtCenter(1.2)} title="放大">+</button>
        <button type="button" className="fit" onClick={fitView} title="居中并适配全部内容">⌖</button>
      </div>
      <ComponentDetail
        compId={detailCompId}
        meterId={detailMeterId}
        onClose={() => { setDetailCompId(null); setDetailMeterId(null); }}
      />
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
  getObstacles,
  zoom,
}: {
  getAnchorPos: (anchorId: string) => { x: number; y: number } | null;
  canvasRef: React.MutableRefObject<HTMLDivElement | null>;
  cableOverlayRef: React.MutableRefObject<SVGSVGElement | null>;
  syncCardPositionsToStore: () => void;
  cancelDragRef: React.MutableRefObject<(() => void) | null>;
  toWorld: (screenX: number, screenY: number) => { x: number; y: number } | null;
  getObstacles: () => WorldRect[];
  zoom: number;
}) {
  const cables = useSimStore((s) => s.cables);
  const selectedCable = useSimStore((s) => s.selectedCable);
  const selectedMeter = useSimStore((s) => s.selectedMeter);
  const removeMeter = useSimStore((s) => s.removeMeter);
  const selectCable = useSimStore((s) => s.selectCable);
  const updateCableEnd = useSimStore((s) => s.updateCableEnd);
  const setCableFloating = useSimStore((s) => s.setCableFloating);
  const setCableDrag = useSimStore((s) => s.setCableDrag);
  const setCableWaypoints = useSimStore((s) => s.setCableWaypoints);
  const cableDrag = useSimStore((s) => s.cableDrag);
  const state = useSimStore((s) => s);
  const particleLayerRef = useRef<SVGGElement>(null);
  const [draggingWaypoint, setDraggingWaypoint] = useState<{ cableId: string; index: number } | null>(null);
  const [cableAxisGuide, setCableAxisGuide] = useState<AlignmentGuide | null>(null);
  const routeCacheRef = useRef<Map<string, ResolvedCablePath[]>>(new Map());
  routeCacheRef.current.clear();

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

  const getResolvedRoutes = (cable: Cable) => {
    const cached = routeCacheRef.current.get(cable.id);
    if (cached) return cached;
    const routes = resolveCableRoutes(
      cable,
      getAnchorPos,
      getObstacles(),
      (anchorId) => {
        const resolved = resolveAnchorPort(anchorId, cables);
        return resolved ? { ownerId: resolved.id, side: resolved.side } : null;
      },
    );
    routeCacheRef.current.set(cable.id, routes);
    return routes;
  };
  useParticleAnimation(particleLayerRef, particleState, getResolvedRoutes, zoom);

  const findNearestWorld = (pt: { x: number; y: number }, excludeCableId?: string) => {
    let best: { id: string; pos: { x: number; y: number } } | null = null;
    let bestDist = 14 / Math.max(0.2, zoom);
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
      const rawPoint = toWorld(ev.clientX, ev.clientY);
      if (!rawPoint) return;
      const liveCable = useSimStore.getState().cables.find((item) => item.id === cableId);
      const otherEnd = end === 'from' ? 'to' : 'from';
      const otherAnchor = liveCable
        ? (otherEnd === 'from' ? liveCable.segments[0]?.fromAnchorId : liveCable.segments[liveCable.segments.length - 1]?.toAnchorId)
        : '';
      const otherPoint = (otherAnchor ? getAnchorPos(otherAnchor) : null)
        ?? (otherEnd === 'from' ? liveCable?.floatingFrom : liveCable?.floatingTo)
        ?? null;
      const snap = findNearestWorld(rawPoint, cableId);
      let pt = snap?.pos ?? rawPoint;
      setCableAxisGuide(null);
      if (!snap && otherPoint) {
        const threshold = 8 / Math.max(0.2, zoom);
        const dx = Math.abs(rawPoint.x - otherPoint.x);
        const dy = Math.abs(rawPoint.y - otherPoint.y);
        if ((ev.shiftKey && dx <= dy) || dx <= threshold) {
          pt = { x: otherPoint.x, y: rawPoint.y };
          setCableAxisGuide({ axis: 'x', value: otherPoint.x, from: Math.min(otherPoint.y, rawPoint.y), to: Math.max(otherPoint.y, rawPoint.y), kind: 'center' });
        } else if (ev.shiftKey || dy <= threshold) {
          pt = { x: rawPoint.x, y: otherPoint.y };
          setCableAxisGuide({ axis: 'y', value: otherPoint.y, from: Math.min(otherPoint.x, rawPoint.x), to: Math.max(otherPoint.x, rawPoint.x), kind: 'center' });
        } else if (useSimStore.getState().snapToGrid && !ev.altKey) {
          const grid = useSimStore.getState().gridSize;
          pt = { x: Math.round(rawPoint.x / grid) * grid, y: Math.round(rawPoint.y / grid) * grid };
        }
      }
      setCableFloating(cableId, end, pt);
      // ★ 联动 owner：owner 不同于当前端点时才显式 setCableFloating
      // （owner 即当前端点时不做重复调用）
      if (owner && (owner.cableId !== cableId || owner.end !== end)) {
        setCableFloating(owner.cableId, owner.end, pt);
      }
      // 排除自身另一端，避免 A.to 误吸附 A.from
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
      setCableAxisGuide(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startDragWaypoint = (
    cableId: string,
    index: number,
    baseWaypoints: Point[],
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingWaypoint({ cableId, index });
    const onMove = (event: MouseEvent) => {
      const point = toWorld(event.clientX, event.clientY);
      if (!point) return;
      const grid = useSimStore.getState().gridSize;
      const next = event.altKey ? point : {
        x: Math.round(point.x / grid) * grid,
        y: Math.round(point.y / grid) * grid,
      };
      const points = baseWaypoints.map((item, itemIndex) => itemIndex === index ? next : item);
      setCableWaypoints(cableId, points);
    };
    const onUp = () => {
      setDraggingWaypoint(null);
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
        const routePaths = getResolvedRoutes(cable);
        const routePoints = routePaths[0]?.points ?? [];
        const isFloating = !fromResolved || !toResolved;
        const editableWaypoints = routePaths.length !== 1
          ? []
          : cable.routeMode === 'orthogonal-manual' && cable.manualWaypoints?.length
            ? cable.manualWaypoints
            : routePoints.slice(1, -1);

        return (
          <g key={cable.id} className={`editable-cable ${isSelected ? 'selected' : ''}`}>
            {routePaths.map((resolvedPath) => resolvedPath.points.length >= 2 && (
              <g key={`${cable.id}-segment-${resolvedPath.segmentIndex}`} data-cable-id={cable.id} data-segment-index={resolvedPath.segmentIndex}>
                <polyline points={pointsToSvg(resolvedPath.points)} fill="none" stroke="transparent" strokeWidth={16 / zoom}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={(event) => { event.stopPropagation(); selectCable(isSelected ? null : cable.id); }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (cable.segments.length !== 1) return;
                    const point = toWorld(event.clientX, event.clientY);
                    if (!point) return;
                    let bestIndex = 0;
                    let bestDistance = Number.POSITIVE_INFINITY;
                    for (let i = 1; i < resolvedPath.points.length; i++) {
                      const a = resolvedPath.points[i - 1];
                      const b = resolvedPath.points[i];
                      const distance = Math.min(Math.hypot(point.x - a.x, point.y - a.y), Math.hypot(point.x - b.x, point.y - b.y));
                      if (distance < bestDistance) { bestDistance = distance; bestIndex = i; }
                    }
                    const full = [...resolvedPath.points];
                    full.splice(bestIndex, 0, point);
                    setCableWaypoints(cable.id, full.slice(1, -1));
                    selectCable(cable.id);
                  }}
                />
                <polyline points={pointsToSvg(resolvedPath.points)} fill="none"
                  // 电力粒子本身为黄色；选中线若也变黄会让运动粒子完全隐形。
                  stroke={isSelected ? '#7C3AED' : color}
                  strokeWidth={isSelected ? 5 : 4}
                  strokeLinecap="round" strokeLinejoin="round"
                  strokeDasharray={isFloating ? '10 6' : undefined}
                  opacity={isSelected ? 0.95 : isFloating ? 0.5 : 0.75}
                  pointerEvents="none" vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
            {isSelected && editableWaypoints.map((point, index) => (
              <circle key={`waypoint-${cable.id}-${index}`} cx={point.x} cy={point.y} r={5 / zoom}
                fill={draggingWaypoint?.cableId === cable.id && draggingWaypoint.index === index ? '#7c3aed' : 'white'}
                stroke="#7c3aed" strokeWidth={1.5 / zoom} style={{ cursor: 'move' }}
                onMouseDown={(event) => startDragWaypoint(cable.id, index, editableWaypoints, event)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setCableWaypoints(cable.id, editableWaypoints.filter((_, itemIndex) => itemIndex !== index));
                }}
              />
            ))}
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
      <g ref={particleLayerRef} className="particle-layer" pointerEvents="none">
        {cables.flatMap((cable) => cable.segments.flatMap((_, segmentIndex) =>
          Array.from({ length: 8 }, (_, particleIndex) => {
            const style = PARTICLE_STYLE[cable.kind];
            return (
              <circle
                key={`${cable.id}:${segmentIndex}:${particleIndex}`}
                data-particle-key={`${cable.id}:${segmentIndex}:${particleIndex}`}
                data-cable-id={cable.id}
                data-segment-index={segmentIndex}
                data-particle-index={particleIndex}
                fill={particleIndex % 2 === 0 ? style.main : style.edge}
                stroke={style.edge}
                opacity={0}
              />
            );
          })
        ))}
      </g>
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
      {cableAxisGuide && (cableAxisGuide.axis === 'x' ? (
        <line x1={cableAxisGuide.value} x2={cableAxisGuide.value} y1={cableAxisGuide.from} y2={cableAxisGuide.to}
          className="alignment-guide center" vectorEffect="non-scaling-stroke" pointerEvents="none" />
      ) : (
        <line y1={cableAxisGuide.value} y2={cableAxisGuide.value} x1={cableAxisGuide.from} x2={cableAxisGuide.to}
          className="alignment-guide center" vectorEffect="non-scaling-stroke" pointerEvents="none" />
      ))}
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
