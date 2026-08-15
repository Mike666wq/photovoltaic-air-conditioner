import { useEffect, useMemo, useRef } from 'react';
import {
  useSimStore,
  type InjectionDataset,
  type SimulationState,
  type TimelineMode,
} from '../store/simulation';
import { applyMapping, type NumericFieldKey } from '../services/dataMapper';
import { parseDatasetTime } from '../services/dataset';
import { buildThermalMasterFrames, type SynchronizedFrame } from '../services/timeSession';

export const BMS_SYNC_TOLERANCE_MS = 2_000;

/** 有序时间序列的最近邻；超出容差或数据源边界时明确返回 -1。 */
let synchronizedFrameCache: { key: string; frames: SynchronizedFrame[] } | null = null;

function synchronizedFrames(thermal: InjectionDataset, bms: InjectionDataset): SynchronizedFrame[] {
  const key = `${thermal.sourceId}:${thermal.injectedAt}|${bms.sourceId}:${bms.injectedAt}`;
  if (synchronizedFrameCache?.key === key) return synchronizedFrameCache.frames;
  const frames = buildThermalMasterFrames(thermal.prepared, bms.prepared, {
    toleranceMs: BMS_SYNC_TOLERANCE_MS,
  });
  synchronizedFrameCache = { key, frames };
  return frames;
}

/** combined 仅把 ±2 秒内的 BMS 点并入主帧；单源模式保留自己的原始时间轴。 */
export function resolveRowsAtCursor(
  state: SimulationState,
  cursorMs: number | null,
  masterIndex = state.timelineIndex,
): Map<string, Record<string, string>> {
  const rows = new Map<string, Record<string, string>>();
  const master = state.injectionDataset;
  if (!master || masterIndex < 0 || masterIndex >= master.rows.length) return rows;
  rows.set(master.sourceId, master.rows[masterIndex]);
  if (state.timelineMode !== 'combined' || cursorMs == null) return rows;
  const bms = state.injectionSources.find((source) => source.role === 'battery-bms');
  if (!bms) return rows;
  const frame = synchronizedFrames(master, bms)[masterIndex];
  if (frame?.timestamp === cursorMs && frame.bms) rows.set(bms.sourceId, frame.bms.raw);
  return rows;
}

function allMappedFields(sources: InjectionDataset[]): NumericFieldKey[] {
  return [...new Set(sources.flatMap((source) => Object.values(source.mapping)))];
}

/** 以主时间轴帧推进所有采集覆盖；未匹配字段标记为不可用，不复用上一帧映射。 */
export function applyTimelineFrame(index: number) {
  const state = useSimStore.getState();
  const master = state.injectionDataset;
  if (!master?.rows.length) return;
  const safeIndex = Math.max(0, Math.min(master.rows.length - 1, index));
  const masterRow = master.rows[safeIndex];
  const cursorMs = master.timeColumn ? parseDatasetTime(masterRow[master.timeColumn]) : null;
  const resolved = resolveRowsAtCursor(state, cursorMs, safeIndex);
  const relevantSources = state.timelineMode === 'combined'
    ? state.injectionSources.filter((source) => source.sourceId === master.sourceId || source.role === 'battery-bms')
    : [master];
  const availability: Partial<Record<NumericFieldKey, boolean>> = {};
  // 所有已导入来源的字段先统一置为不可用；当前模式解析到值后再逐项打开。
  // 这样切到 BMS 原始轴时，热工/PV 字段不会残留上一帧的 availability=true。
  for (const field of allMappedFields(state.injectionSources)) availability[field] = false;
  const updates: Partial<SimulationState> = {};
  for (const source of relevantSources) {
    const row = resolved.get(source.sourceId);
    if (!row) continue;
    const sourceUpdates = applyMapping(source.mapping, [row], 'first');
    Object.assign(updates, sourceUpdates);
    for (const field of Object.values(source.mapping)) {
      availability[field] = typeof sourceUpdates[field] === 'number' && Number.isFinite(sourceUpdates[field]);
    }
  }
  useSimStore.setState({
    ...updates,
    timelineIndex: safeIndex,
    timelineCursorMs: cursorMs,
    injectionFieldAvailability: availability,
  });
}

/** 兼容大屏旧调用；映射来自已保存的数据源，不再逐帧模糊猜测。 */
export function applyRowToStore(row: Record<string, string>, confirmedMapping?: Record<string, NumericFieldKey>) {
  const mapping = confirmedMapping ?? useSimStore.getState().injectionDataset?.mapping ?? {};
  const updates = applyMapping(mapping, [row], 'first');
  const availability: Partial<Record<NumericFieldKey, boolean>> = {};
  for (const field of Object.values(mapping)) {
    availability[field] = typeof updates[field] === 'number' && Number.isFinite(updates[field]);
  }
  useSimStore.setState({ ...updates, injectionFieldAvailability: availability });
}

export function TimelineControls() {
  const dataset = useSimStore((s) => s.injectionDataset);
  const sources = useSimStore((s) => s.injectionSources);
  const timelineMode = useSimStore((s) => s.timelineMode);
  const timelineIndex = useSimStore((s) => s.timelineIndex);
  const timelinePlaying = useSimStore((s) => s.timelinePlaying);
  const timelineSpeed = useSimStore((s) => s.timelineSpeed);
  const setTimelinePlaying = useSimStore((s) => s.setTimelinePlaying);
  const setTimelineSpeed = useSimStore((s) => s.setTimelineSpeed);
  const setTimelineMode = useSimStore((s) => s.setTimelineMode);
  const rows = useMemo(() => dataset?.rows ?? [], [dataset]);
  const maxIdx = Math.max(0, rows.length - 1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const accumRef = useRef(0);

  useEffect(() => {
    if (!timelinePlaying || rows.length === 0) return;
    lastTsRef.current = performance.now();
    accumRef.current = 0;
    const tick = (now: number) => {
      const dt = (now - lastTsRef.current) / 1000;
      lastTsRef.current = now;
      accumRef.current += dt * useSimStore.getState().timelineSpeed;
      while (accumRef.current >= 1) {
        accumRef.current -= 1;
        const next = useSimStore.getState().timelineIndex + 1;
        if (next > maxIdx) {
          setTimelinePlaying(false);
          return;
        }
        applyTimelineFrame(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (useSimStore.getState().timelinePlaying) setTimelinePlaying(false);
    };
  }, [timelinePlaying, rows, maxIdx, setTimelinePlaying]);

  if (!dataset || rows.length === 0) return null;
  const currentRow = rows[Math.max(0, Math.min(timelineIndex, maxIdx))] ?? {};
  const timeStr = currentRow[dataset.timeColumn ?? ''] ?? '';
  const hasThermal = sources.some((source) => source.role === 'thermal-electrical' || source.role === 'mixed');
  const hasBms = sources.some((source) => source.role === 'battery-bms');
  const modes: Array<{ value: TimelineMode; label: string }> = [
    ...(hasThermal && hasBms ? [{ value: 'combined' as const, label: '综合同步' }] : []),
    ...(hasThermal ? [{ value: 'thermal-electrical' as const, label: '热工/电表' }] : []),
    ...(hasBms ? [{ value: 'battery-bms' as const, label: 'BMS 原始' }] : []),
  ];
  const moveTo = (idx: number) => applyTimelineFrame(Math.max(0, Math.min(maxIdx, idx)));

  return (
    <div className="timeline-controls">
      <div className="timeline-left">
        <button className="timeline-btn primary" onClick={() => {
          if (timelineIndex >= maxIdx) moveTo(0);
          setTimelinePlaying(!timelinePlaying);
        }} aria-label={timelinePlaying ? '暂停回放' : '开始回放'}>{timelinePlaying ? '⏸' : '▶'}</button>
        <button className="timeline-btn" onClick={() => moveTo(timelineIndex - 1)} aria-label="上一帧">⏮</button>
        <button className="timeline-btn" onClick={() => moveTo(timelineIndex + 1)} aria-label="下一帧">⏭</button>
        {modes.length > 1 && (
          <select className="timeline-mode" value={timelineMode} onChange={(event) => {
            setTimelineMode(event.target.value as TimelineMode);
            queueMicrotask(() => applyTimelineFrame(0));
          }} aria-label="回放时间轴模式">
            {modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        )}
        <span className="timeline-file" title={dataset.sourceFile}>{dataset.sourceFile}</span>
      </div>
      <div className="timeline-slider-wrap">
        <input className="timeline-slider" type="range" min={0} max={maxIdx}
          value={Math.max(0, Math.min(timelineIndex, maxIdx))}
          onChange={(event) => moveTo(Number(event.target.value))} aria-label="时间轴进度" />
      </div>
      <div className="timeline-right">
        <span className="timeline-time">{timeStr || '—'}</span>
        <span className="timeline-pos">{Math.max(0, Math.min(timelineIndex, maxIdx)) + 1} / {rows.length}</span>
        <div className="timeline-speeds">
          {[1, 2, 4, 8].map((speed) => (
            <button key={speed} className={`timeline-speed ${timelineSpeed === speed ? 'active' : ''}`}
              onClick={() => setTimelineSpeed(speed)}>{speed}×</button>
          ))}
        </div>
      </div>
    </div>
  );
}
