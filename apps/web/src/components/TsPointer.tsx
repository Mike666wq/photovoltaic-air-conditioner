import { useEffect, useState } from 'react';
import { useSimStore } from '../store/simulation';
import type { MeterInstance } from '../data/meters';
import { TEMP_BIND_PDF_COLUMN } from '../data/meters';
import { readCellCandidates, ENV_TEMP_COLUMNS, normTemp } from '../services/meterInject';

/**
 * 温度传感器指针覆盖层（M1.5 Round 3）
 *
 * 渲染位置：覆盖在 temp-sensor 仪表卡片中央（SVG viewBox 240×240，圆心 (120, 100)）。
 *
 * 与 demo.html:1399-1410 一致：
 *   - 数据源 `state.at_temp` → 归一化 0..1
 *   - 指针角度 = -90° + norm * 180°（0℃→左水平, 50℃→右水平）
 *   - 旋转中心 (120, 100)
 *
 * 为什么不放在 SVG 内？
 *   - 同样的 SVG 同步问题（每 200ms 写 transform 会触发 clone）。
 *   - 用独立 SVG + transform 属性 setInterval(200ms) 局部更新，不影响主 SVG。
 */

const PAD_X = 10;
const PAD_TOP = 8;
const TITLE_H = 24;
const PAD_BOTTOM = 10;
const MAX_SVG_H = 220;
const VIEW_BOX = 240;
const CENTER_X = 120;
const CENTER_Y = 100;
const POINTER_LEN = 38; // 从圆心向上 38px（SVG 内 y=62 → 距 100 = 38）

interface TsPointerProps {
  meter: MeterInstance;
}

/** 从数据集当前行解析该 TS 绑定的温度（无绑定 → null） */
function resolveMeterTemp(meter: MeterInstance): number | null {
  const bind = meter.bind;
  const isTempBind =
    bind === 'env-temp' || bind === 'supply-temp' || bind === 'return-temp' || bind === 'outlet-temp';
  if (!isTempBind) return null;
  const state = useSimStore.getState();
  // env-temp 支持 PDF T3.PV + XLSX 环境温度；其余走绑定 PDF 列
  const candidates = bind === 'env-temp' ? ENV_TEMP_COLUMNS : [TEMP_BIND_PDF_COLUMN[bind]];
  return readCellCandidates(state, candidates);
}

/** 无数据集时的温度 fallback（对齐 meterInject.ts buildTempInject：env→at_temp / supply·return→tank_temp / outlet→hp_temp） */
function fallbackTemp(bind: string | undefined): number {
  const s = useSimStore.getState();
  switch (bind) {
    case 'env-temp': return s.at_temp;
    case 'supply-temp':
    case 'return-temp': return s.tank_temp;
    case 'outlet-temp': return s.hp_temp;
    default: return s.tank_temp;
  }
}

export function TsPointer({ meter }: TsPointerProps) {
  const cardPositions = useSimStore((s) => s.cardPositions);
  const animationOn = useSimStore((s) => s.animationOn);
  // 200ms 节流更新指针角度（demo.html 用 200ms；M2 真数据接入后由 store 推 → 可降到 100ms）
  // 归一化：10~100℃ 映射 0~1（fallback 值按绑定类型从 store 实时取）
  const [norm, setNorm] = useState<number>(() => {
    const live = resolveMeterTemp(meter);
    const fb = fallbackTemp(meter.bind);
    return live != null ? normTemp(live) : Math.max(0, Math.min(1, (fb - 10) / 90));
  });

  useEffect(() => {
    if (!animationOn) return;
    const id = window.setInterval(() => {
      const live = resolveMeterTemp(meter);
      const v = live ?? fallbackTemp(meter.bind);
      setNorm(Math.max(0, Math.min(1, (v - 10) / 90)));
    }, 200);
    return () => window.clearInterval(id);
  }, [animationOn, meter.id, meter.bind]);

  const card = cardPositions[meter.id];
  if (!card) return null;

  // SVG 在卡片内的实际尺寸
  const svgWidth = card.w - PAD_X * 2;
  const svgHeight = Math.min(svgWidth, MAX_SVG_H);
  const svgStartX = PAD_X;
  const svgStartY = PAD_TOP + TITLE_H;

  // 指针覆盖 SVG（覆盖整个 SVG 区域，渲染一个旋转的 <line>）
  const overlayW = svgWidth;
  const overlayH = svgHeight;
  // SVG 内部坐标 → 覆盖 SVG 像素坐标
  const cx = (CENTER_X / VIEW_BOX) * overlayW;
  const cy = (CENTER_Y / VIEW_BOX) * overlayH;
  const len = (POINTER_LEN / VIEW_BOX) * overlayW;
  const angle = -90 + norm * 180; // 0℃→-90°（左）, 50℃→+90°（右）

  // 覆盖层左上角在画布内的绝对坐标
  const overlayX = card.x + svgStartX;
  const overlayY = card.y + svgStartY;

  return (
    <svg
      className="ts-pointer-overlay"
      width={overlayW}
      height={overlayH}
      viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
      preserveAspectRatio="xMidYMid meet"
      style={{
        position: 'absolute',
        left: `${overlayX}px`,
        top: `${overlayY}px`,
        pointerEvents: 'none',
        zIndex: 5,
        overflow: 'visible',
      }}
    >
      <g
        style={{
          transformOrigin: `${CENTER_X}px ${CENTER_Y}px`,
          transform: `rotate(${angle}deg)`,
          transition: 'transform 0.4s ease',
        }}
      >
        <line
          x1={CENTER_X}
          y1={CENTER_Y}
          x2={CENTER_X}
          y2={CENTER_Y - POINTER_LEN}
          stroke="#EF4444"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}