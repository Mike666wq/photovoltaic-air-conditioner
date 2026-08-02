// 左侧调色板：3 种线缆（无限拖出）+ 2 种仪表（拖出变可拖动的 component-card）
// 使用 HTML5 drag-and-drop API，画布监听 onDragOver/onDrop 完成创建
// 支持折叠：默认 40px 图标条 + hover 300ms 展开 + 点击图标锁定展开

import { useState, useRef, useEffect } from 'react';
import { CABLE_PALETTE, METER_PALETTE, type CableKind, type MeterType } from '../data/palettes';
import { useSimStore } from '../store/simulation';

// 拖出数据的 MIME 类型（与 CircuitCanvas onDrop 配合）
export const DRAG_MIME_CABLE = 'application/x-palette-cable';
export const DRAG_MIME_METER = 'application/x-palette-meter';

export type DropType =
  | { kind: 'cable'; type: CableKind }
  | { kind: 'meter'; type: MeterType };

export function PalettePanel() {
  const leftPanelOpen = useSimStore((s) => s.leftPanelOpen);
  const toggleLeftPanel = useSimStore((s) => s.toggleLeftPanel);
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  const collapsed = !leftPanelOpen;

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
    'palette-panel',
    collapsed && 'collapsed',
    collapsed && hoverOpen && 'hover-open',
  ].filter(Boolean).join(' ');

  return (
    <div className={panelCls} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {showFull ? (
        <>
          {/* 展开状态下的收起按钮（用户已锁定展开时可点击收起） */}
          {leftPanelOpen && (
            <button
              type="button"
              className="palette-collapse-btn"
              title="收起调色板"
              onClick={toggleLeftPanel}
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>收起</span>
            </button>
          )}

          {/* === 线缆区 === */}
          <div className="palette-section">
            <div className="palette-title">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path d="M4 4c0 8 16 8 16 0M4 20c0-8 16-8 16 0M4 4v16M20 4v16"
                  fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span>线缆区</span>
              <span className="palette-hint">∞ 无限</span>
            </div>
            <div className="palette-items">
              {CABLE_PALETTE.map((c) => (
                <div
                  key={c.kind}
                  className="palette-item palette-cable"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME_CABLE, c.kind);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={`拖出 ${c.label}`}
                >
                  <svg width="100%" height="20" viewBox="0 0 100 20">
                    <line x1="2" y1="10" x2="98" y2="10" stroke={c.color} strokeWidth="4" strokeLinecap="round" />
                    <circle cx="2"  cy="10" r="3" fill={c.color} />
                    <circle cx="98" cy="10" r="3" fill={c.color} />
                  </svg>
                  <span className="palette-label" style={{ color: c.color }}>{c.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* === 仪表区 === */}
          <div className="palette-section">
            <div className="palette-title">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              <span>仪表区</span>
              <span className="palette-hint">∞ 无限</span>
            </div>
            <div className="palette-items">
              {METER_PALETTE.map((m) => (
                <div
                  key={m.type}
                  className="palette-item palette-meter"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME_METER, m.type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={`拖出 ${m.label}（拖到画布即变成可拖动的部件卡片）`}
                >
                  <span className="meter-symbol" style={{ background: m.color }}>{m.symbol}</span>
                  <span className="palette-label">{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="palette-foot">
            <div className="palette-foot-row">💡 线缆/仪表拖到画布即可放置</div>
            <div className="palette-foot-row">🔗 端点 8px 内自动吸附（部件/线缆均可）</div>
            <div className="palette-foot-row">🖱 点击选中 + 删除按钮</div>
            <div className="palette-foot-row">⚡ 仪表拖出后可作为线缆连接端点</div>
          </div>
        </>
      ) : (
        <div className="palette-rail" title="调色板（hover 展开）">
          <div
            className="palette-rail-icon"
            title="点击锁定展开调色板"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); toggleLeftPanel(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLeftPanel(); } }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M4 4c0 8 16 8 16 0M4 20c0-8 16-8 16 0M4 4v16M20 4v16"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <div
            className="palette-rail-icon"
            title="点击锁定展开调色板"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); toggleLeftPanel(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLeftPanel(); } }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <circle cx="12" cy="12" r="3" fill="currentColor" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}

// 辅助：读取 drop 时的拖出类型（支持线缆 + 仪表）
export function readDropType(e: React.DragEvent): DropType | null {
  const cable = e.dataTransfer.getData(DRAG_MIME_CABLE);
  if (cable) return { kind: 'cable', type: cable as CableKind };
  const meter = e.dataTransfer.getData(DRAG_MIME_METER);
  if (meter) return { kind: 'meter', type: meter as MeterType };
  return null;
}