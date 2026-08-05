import { useState, useRef, useEffect } from 'react';
import { useSimStore, SimulationState } from '../store/simulation';
import { PRESETS, PRESET_LABELS } from '../data/presets';
import { CableControlItem } from './CableControlItem';
import { CableControlDetail } from './CableControlDetail';

interface SliderProps {
  label: string;
  field: keyof SimulationState;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits?: number;
}

function Slider({ label, field, min, max, step, unit, digits = 2 }: SliderProps) {
  const value = useSimStore((s) => s[field]) as number;
  const setField = useSimStore((s) => s.setField);

  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => setField(field, parseFloat(e.target.value))}
        aria-label={label}
      />
      <span className="val-display">{(value as number).toFixed(digits)} {unit}</span>
    </div>
  );
}

export function ControlPanel() {
  const applyPreset = useSimStore((s) => s.loadPreset);
  const randomize = useSimStore((s) => s.randomize);
  const resetAll = useSimStore((s) => s.resetAll);
  const rightPanelOpen = useSimStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useSimStore((s) => s.toggleRightPanel);
  // M1.5 Round 9：线缆控制订阅
  const cables = useSimStore((s) => s.cables);
  const selectedCable = useSimStore((s) => s.selectedCable);
  const selectCable = useSimStore((s) => s.selectCable);
  const selectedCableData = cables.find((c) => c.id === selectedCable) ?? null;
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  const collapsed = !rightPanelOpen;

  const onEnter = () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoverOpen(true), 300);
  };
  const onLeave = () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoverOpen(false), 200);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
  }, []);

  const showFull = !collapsed || hoverOpen;
  const panelCls = [
    'control-panel',
    collapsed && 'collapsed',
    collapsed && hoverOpen && 'hover-open',
  ].filter(Boolean).join(' ');

  return (
    <div className={panelCls} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {showFull ? (
        <>
          {/* 展开状态下的收起按钮（用户已锁定展开时可点击收起） */}
          {rightPanelOpen && (
            <button
              type="button"
              className="control-collapse-btn"
              title="收起控制面板"
              onClick={toggleRightPanel}
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>收起</span>
            </button>
          )}

          <div className="panel-section">
            <div className="panel-title">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 6v6l4 2" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
              <span>预设场景（9 个）</span>
            </div>
            <div className="preset-grid">
              {Object.keys(PRESETS).map((key) => (
                <button
                  key={key}
                  className="preset-btn"
                  onClick={() => applyPreset(key as keyof typeof PRESETS)}
                >
                  {PRESET_LABELS[key]}
                </button>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="panel-title">
              <svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
              <span>光伏 / 储能</span>
            </div>
            <Slider label="PV 功率"   field="pv_power"  min={0} max={6}   step={0.1} unit="kW" />
            <Slider label="阳光强度"  field="pv_sun"    min={0} max={1}   step={0.05} unit=""   digits={2} />
            <Slider label="SOC"       field="bat_soc"   min={0} max={100} step={1}   unit="%"  digits={0} />
          </div>

          <div className="panel-section">
            <div className="panel-title">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 1v6m0 10v6M4.22 4.22l4.24 4.24m7.08 7.08l4.24 4.24M1 12h6m10 0h6" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
              <span>热泵 / 水箱</span>
            </div>
            <Slider label="HP 温度"   field="hp_temp"     min={16} max={30}  step={1}   unit="℃"   digits={0} />
            <Slider label="HP 功率"   field="hp_power"    min={0}  max={8}   step={0.1} unit="kW"  />
            <Slider label="水箱温度"  field="tank_temp"   min={0}  max={100} step={1}   unit="℃"   digits={0} />
            <Slider label="水箱水量"  field="tank_volume" min={0}  max={100} step={1}   unit="%"   digits={0} />
            <Slider label="水箱流量"  field="tank_flow"   min={0}  max={5}   step={0.1} unit="m³/h" />
            <Slider label="PCM 温度" field="pcm_temp" min={0} max={50} step={1} unit="℃" digits={0} />
            <Slider label="水泵流量"  field="pump_flow"   min={0}  max={5}   step={0.1} unit="m³/h" />
          </div>

          <div className="panel-section">
            <div className="panel-title">
              <svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
              <span>末端</span>
            </div>
            <Slider label="末端温度"  field="at_temp"   min={18} max={28} step={1}   unit="℃" digits={0} />
            <Slider label="末端风档位" field="at_fan_speed" min={0} max={4} step={1} unit="档" digits={0} />
            <Slider label="水冷风扇水位" field="sac_water_level" min={0} max={100} step={1} unit="%" digits={0} />
            <Slider label="水冷风扇水温" field="sac_water_temp" min={0} max={100} step={1} unit="℃" digits={0} />
            <Slider label="水冷风扇风速" field="sac_fan_speed" min={0} max={1} step={0.05} unit="" digits={2} />
            <Slider label="水冷风扇出风温度" field="sac_outlet_temp" min={16} max={35} step={1} unit="℃" digits={0} />
            <Slider label="负载功率" field="load_power_kw" min={0} max={3} step={0.1} unit="kW" digits={2} />
            <Slider label="电池功率" field="battery_power_kw" min={-3} max={3} step={0.1} unit="kW" digits={2} />
          </div>

          <div className="panel-section">
            <div className="panel-title">
              <svg viewBox="0 0 24 24"><path d="M3 12h18M12 3v18" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
              <span>流体粒子（手控）</span>
            </div>
            <Slider label="电力线流量" field="pl_flow" min={0} max={5} step={0.1} unit="" />
            <Slider label="制冷剂量"   field="rl_flow" min={0} max={5} step={0.1} unit="" />
            <Slider label="水线流速"   field="wl_flow" min={0} max={5} step={0.1} unit="" />
          </div>

          {/* M1.5 Round 10：线缆控制（列表 + 详情；详情面板仅选中线缆时显示） */}
          <div className="panel-section">
            <div className="panel-title">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path d="M4 4c0 8 16 8 16 0M4 20c0-8 16-8 16 0M4 4v16M20 4v16"
                  fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span>线缆控制</span>
              <span className="palette-hint">{cables.length} 条</span>
            </div>
            {cables.length === 0 ? (
              <div className="empty-hint">
                暂无线缆，请从左侧调色板拖出
              </div>
            ) : (
              <>
                <div className="cable-list">
                  {cables.map(cable => (
                    <CableControlItem
                      key={cable.id}
                      cable={cable}
                      isSelected={selectedCable === cable.id}
                      onSelect={selectCable}
                    />
                  ))}
                </div>
                {selectedCableData ? (
                  <CableControlDetail cable={selectedCableData} />
                ) : (
                  <div className="cable-detail-empty">
                    点击上方线缆查看详情
                  </div>
                )}
              </>
            )}
          </div>

          <div className="panel-section">
            <button className="action-btn btn-random" onClick={randomize}>🎲 随机扰动</button>
            <button className="action-btn btn-reset" onClick={resetAll}>⏮ 重置</button>
          </div>

          <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '10px', padding: '8px', background: '#f8fafc', borderRadius: '4px' }}>
            💡 提示：<br />
            · 点击部件 SVG 切换运行状态（PV/CB/GS/HP/Pump/AT/水冷风扇/Load）<br />
            · 调节滑块实时刷新动画；预设场景一键加载<br />
            · 流体粒子滑块覆盖物理状态（pl/rl/wl = 电力/制冷剂/水）
          </div>
        </>
      ) : (
        <div className="control-rail" title="控制面板（hover 展开）">
          <div
            className="control-rail-icon"
            title="点击锁定展开控制面板"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); toggleRightPanel(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRightPanel(); } }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M12 6v6l4 2" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
          <div
            className="control-rail-icon"
            title="点击锁定展开控制面板"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); toggleRightPanel(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRightPanel(); } }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M3 17l6-6 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
