import { useEffect, useMemo, useRef, useState } from 'react';
import { useSimStore } from '../store/simulation';
import { applyMapping, matchColumnToField, type NumericFieldKey } from '../services/dataMapper';

/**
 * 时序回放控制条（M2-β）
 *
 * 功能：
 *   - ▶ / ⏸ 播放暂停（按 timelineSpeed 倍速推进 timelineIndex）
 *   - 进度条拖动（scrub）
 *   - 倍速 1×/2×/4×/8×
 *   - 显示当前行时间戳（timeColumn）+ 已导入文件
 *
 * 数据流：
 *   store.injectionDataset（完整数据集）→ 当前行 timelineIndex → applyRowToStore 逐字段写入 store
 *   → CircuitCanvas 各 ComponentSlot / MeterSlot 因 state 变化自动重新注入
 */
export function TimelineControls() {
  const dataset = useSimStore((s) => s.injectionDataset);
  const timelineIndex = useSimStore((s) => s.timelineIndex);
  const timelinePlaying = useSimStore((s) => s.timelinePlaying);
  const timelineSpeed = useSimStore((s) => s.timelineSpeed);
  const setTimelineIndex = useSimStore((s) => s.setTimelineIndex);
  const setTimelinePlaying = useSimStore((s) => s.setTimelinePlaying);
  const setTimelineSpeed = useSimStore((s) => s.setTimelineSpeed);

  const rows = useMemo(() => dataset?.rows ?? [], [dataset]);
  const maxIdx = Math.max(0, rows.length - 1);

  // 播放推进：RAF 循环，用时间累加器保证 1×≈1 行/秒（而非 1 行/帧），倍速真正生效
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const accumRef = useRef<number>(0);

  useEffect(() => {
    if (!timelinePlaying || rows.length === 0) return;
    lastTsRef.current = performance.now();
    accumRef.current = 0;
    const tick = (now: number) => {
      const dt = (now - lastTsRef.current) / 1000;
      lastTsRef.current = now;
      const speed = useSimStore.getState().timelineSpeed;
      // 时间累加：每累计 1 秒推进 1 行（1×=1 行/秒，8×=8 行/秒）
      accumRef.current += dt * speed;
      let advanced = false;
      while (accumRef.current >= 1) {
        accumRef.current -= 1;
        advanced = true;
        const cur = useSimStore.getState().timelineIndex;
        const next = cur + 1;
        if (next > maxIdx) {
          setTimelinePlaying(false);
          return;
        }
        applyRowToStore(rows[next]);
        setTimelineIndex(next);
      }
      if (advanced || accumRef.current > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [timelinePlaying, rows, maxIdx, setTimelineIndex, setTimelinePlaying]);

  if (!dataset || rows.length === 0) return null;

  const currentRow = rows[Math.min(timelineIndex, maxIdx)] ?? {};
  const timeStr = currentRow[dataset.timeColumn ?? ''] ?? '';

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = Number(e.target.value);
    applyRowToStore(rows[idx]);
    setTimelineIndex(idx);
  };

  return (
    <div className="timeline-controls">
      <div className="timeline-left">
        <button
          className="timeline-btn primary"
          onClick={() => {
            if (timelineIndex >= maxIdx) {
              // 到末尾 → 从头
              applyRowToStore(rows[0]);
              setTimelineIndex(0);
            }
            setTimelinePlaying(!timelinePlaying);
          }}
          disabled={rows.length === 0}
          aria-label={timelinePlaying ? '暂停回放' : '开始回放'}
        >
          {timelinePlaying ? '⏸' : '▶'}
        </button>
        <button
          className="timeline-btn"
          onClick={() => {
            const idx = Math.max(0, timelineIndex - 1);
            applyRowToStore(rows[idx]);
            setTimelineIndex(idx);
          }}
          aria-label="上一帧"
        >
          ⏮
        </button>
        <button
          className="timeline-btn"
          onClick={() => {
            const idx = Math.min(maxIdx, timelineIndex + 1);
            applyRowToStore(rows[idx]);
            setTimelineIndex(idx);
          }}
          aria-label="下一帧"
        >
          ⏭
        </button>
        <span className="timeline-file" title={dataset.sourceFile}>
          {dataset.sourceFile}
        </span>
      </div>

      <div className="timeline-slider-wrap">
        <input
          className="timeline-slider"
          type="range"
          min={0}
          max={maxIdx}
          value={Math.min(timelineIndex, maxIdx)}
          onChange={handleScrub}
          aria-label="时间轴进度"
        />
      </div>

      <div className="timeline-right">
        <span className="timeline-time">{timeStr || '—'}</span>
        <span className="timeline-pos">
          {Math.min(timelineIndex, maxIdx) + 1} / {rows.length}
        </span>
        <div className="timeline-speeds">
          {[1, 2, 4, 8].map((s) => (
            <button
              key={s}
              className={`timeline-speed ${timelineSpeed === s ? 'active' : ''}`}
              onClick={() => setTimelineSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 把一行采集数据映射到 store 字段（复用 applyMapping：列名 → NumericFieldKey 自动匹配）。
 * 仅写入可映射的数值字段；boolean/string 字段（flag 状态）无数据源，保持当前值。
 */
export function applyRowToStore(row: Record<string, string>) {
  const mapping: Record<string, NumericFieldKey> = {};
  for (const header of Object.keys(row)) {
    const mapped = matchColumnToField(header);
    if (mapped) mapping[header] = mapped;
  }
  if (Object.keys(mapping).length === 0) return;
  const updates = applyMapping(mapping, [row], 'first');
  if (Object.keys(updates).length > 0) {
    useSimStore.setState(updates);
  }
}
