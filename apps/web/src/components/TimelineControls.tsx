import { useEffect, useMemo, useRef } from 'react';
import {
  useSimStore,
  type InjectionDataset,
  type SimulationState,
  type TimelineMode,
} from '../store/simulation';
import { applyMapping, type NumericFieldKey } from '../services/dataMapper';
import {
  buildPlaybackSession,
  type PlaybackFrame,
  type PlaybackSession,
} from '../services/playbackSession';
import { buildSchematicFrame } from '../services/schematicFrame';

export const BMS_SYNC_TOLERANCE_MS = 2_000;

let sessionCache: { key: string; session: PlaybackSession } | null = null;

function sourcesForMode(state: SimulationState): InjectionDataset[] {
  if (!state.injectionSources.length) return [];
  const activeIds = new Set(state.activePlaybackSourceIds);
  const activeSources = state.injectionSources.filter((source) => activeIds.has(source.sourceId));
  const sessionSources = activeSources;
  if (state.timelineMode === 'combined') {
    const relevant = sessionSources.filter((source) =>
      source.role === 'thermal-electrical' || source.role === 'mixed' || source.role === 'battery-bms',
    );
    return relevant.length ? relevant : state.injectionDataset ? [state.injectionDataset] : [];
  }
  const active = state.injectionDataset;
  if (active && activeIds.has(active.sourceId) && active.role === state.timelineMode) return [active];
  const matched = sessionSources.find((source) => source.role === state.timelineMode);
  return matched ? [matched] : active ? [active] : [];
}

function sessionForState(state: SimulationState): PlaybackSession | null {
  const sources = sourcesForMode(state);
  if (!sources.length) return null;
  const anchor = state.timelineMode === 'combined'
    ? sources.find((source) => source.role === 'thermal-electrical' || source.role === 'mixed') ?? sources[0]
    : sources[0];
  const key = [state.timelineMode, anchor.sourceId, ...sources.map((source) => `${source.sourceId}:${source.injectedAt}`)].join('|');
  if (sessionCache?.key === key) return sessionCache.session;
  const session = buildPlaybackSession({
    sources: sources.map((source) => source.prepared),
    anchorSourceId: anchor.sourceId,
    toleranceMs: BMS_SYNC_TOLERANCE_MS,
  });
  sessionCache = { key, session };
  return session;
}

/** 当前严格同步帧内的原始行，供既有仪表读取接口兼容使用。 */
export function resolveRowsAtCursor(
  state: SimulationState,
  cursorMs: number | null,
  frameIndex = state.timelineIndex,
): Map<string, Record<string, string>> {
  const rows = new Map<string, Record<string, string>>();
  const session = sessionForState(state);
  if (!session?.frames.length || frameIndex < 0) return rows;
  const frame = session.frames[Math.min(frameIndex, session.frames.length - 1)];
  if (cursorMs != null && frame.timestamp !== cursorMs) return rows;
  for (const [sourceId, sample] of Object.entries(frame.samples)) rows.set(sourceId, sample.raw);
  return rows;
}

/** 以 strict-intersection frame 原子更新原理图测量、状态、可用性和来源证据。 */
export function applyTimelineFrame(index: number) {
  const state = useSimStore.getState();
  const session = sessionForState(state);
  if (!session?.frames.length) return;
  const safeIndex = Math.max(0, Math.min(session.frames.length - 1, index));
  const frame = session.frames[safeIndex];
  const schematic = buildSchematicFrame(frame, state);
  useSimStore.setState({
    ...schematic.measurements,
    ...schematic.statuses,
    timelineIndex: safeIndex,
    timelineCursorMs: frame.timestamp,
    injectionFieldAvailability: schematic.measurementAvailability,
    playbackSnapshot: schematic.snapshot,
    controlMode: 'replay',
  });
}

/** 兼容旧的单行注入调用；新回放统一走 applyTimelineFrame。 */
export function applyRowToStore(row: Record<string, string>, confirmedMapping?: Record<string, NumericFieldKey>) {
  const mapping = confirmedMapping ?? useSimStore.getState().injectionDataset?.mapping ?? {};
  const updates = applyMapping(mapping, [row], 'first');
  const availability: Partial<Record<NumericFieldKey, boolean>> = {};
  for (const field of Object.values(mapping)) {
    availability[field] = typeof updates[field] === 'number' && Number.isFinite(updates[field]);
  }
  useSimStore.setState({ ...updates, injectionFieldAvailability: availability });
}

function nearestFrameIndex(frames: PlaybackFrame[], timestamp: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  const previous = Math.max(0, low - 1);
  const next = Math.min(frames.length - 1, low);
  return Math.abs(frames[previous].timestamp - timestamp) <= Math.abs(frames[next].timestamp - timestamp)
    ? previous
    : next;
}

function formatTimestamp(timestamp: number | null): string {
  return timestamp == null ? '—' : new Date(timestamp).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function TimelineControls() {
  const sources = useSimStore((state) => state.injectionSources);
  const dataset = useSimStore((state) => state.injectionDataset);
  const timelineMode = useSimStore((state) => state.timelineMode);
  const timelineIndex = useSimStore((state) => state.timelineIndex);
  const timelinePlaying = useSimStore((state) => state.timelinePlaying);
  const timelineSpeed = useSimStore((state) => state.timelineSpeed);
  const controlMode = useSimStore((state) => state.controlMode);
  const setTimelinePlaying = useSimStore((state) => state.setTimelinePlaying);
  const setTimelineSpeed = useSimStore((state) => state.setTimelineSpeed);
  const setTimelineMode = useSimStore((state) => state.setTimelineMode);
  const clearInjectionDataset = useSimStore((state) => state.clearInjectionDataset);
  const exitReplay = useSimStore((state) => state.exitReplay);
  const stateForSession = useMemo(() => useSimStore.getState(), [sources, dataset, timelineMode]);
  const session = useMemo(() => sessionForState(stateForSession), [stateForSession]);
  const frames = session?.frames ?? [];
  const maxIndex = Math.max(0, frames.length - 1);
  const safeIndex = Math.max(0, Math.min(timelineIndex, maxIndex));
  const currentFrame = frames[safeIndex] ?? null;
  const rafRef = useRef<number | null>(null);
  const lastWallTimeRef = useRef(0);
  const simulatedCursorRef = useRef(0);

  useEffect(() => {
    if (!timelinePlaying || !frames.length) return;
    lastWallTimeRef.current = performance.now();
    simulatedCursorRef.current = frames[Math.max(0, Math.min(useSimStore.getState().timelineIndex, maxIndex))].timestamp;
    const tick = (now: number) => {
      const elapsedMs = now - lastWallTimeRef.current;
      lastWallTimeRef.current = now;
      simulatedCursorRef.current += elapsedMs * useSimStore.getState().timelineSpeed;
      const current = useSimStore.getState().timelineIndex;
      let next = current;
      while (next + 1 <= maxIndex && frames[next + 1].timestamp <= simulatedCursorRef.current) next += 1;
      if (next !== current) applyTimelineFrame(next);
      if (next >= maxIndex) {
        setTimelinePlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [frames, maxIndex, setTimelinePlaying, timelinePlaying]);

  if (!dataset || !sources.length) return null;
  const hasThermal = sources.some((source) => source.role === 'thermal-electrical' || source.role === 'mixed');
  const hasBms = sources.some((source) => source.role === 'battery-bms' || source.role === 'mixed');
  const modes: Array<{ value: TimelineMode; label: string }> = [
    ...(hasThermal && hasBms ? [{ value: 'combined' as const, label: '严格同步交集' }] : []),
    ...(hasThermal ? [{ value: 'thermal-electrical' as const, label: '热工/电表' }] : []),
    ...(hasBms ? [{ value: 'battery-bms' as const, label: 'BMS 原始' }] : []),
  ];
  const moveTo = (index: number) => {
    if (timelinePlaying) setTimelinePlaying(false);
    applyTimelineFrame(Math.max(0, Math.min(maxIndex, index)));
  };

  if (!frames.length) {
    return (
      <div className="timeline-controls timeline-empty" role="status">
        <strong>没有可同步的交集帧</strong>
        <span>请检查文件时间、异常行与 ±{BMS_SYNC_TOLERANCE_MS / 1000} 秒匹配条件。</span>
        <button onClick={clearInjectionDataset}>清除数据源</button>
      </div>
    );
  }

  const sourceLabel = session?.sourceIds.map((id) => sources.find((source) => source.sourceId === id)?.sourceFile ?? id).join(' + ') ?? '';
  return (
    <div className="timeline-controls" data-control-mode={controlMode}>
      <div className="timeline-left">
        <button className="timeline-btn primary" onClick={() => {
          applyTimelineFrame(safeIndex >= maxIndex ? 0 : safeIndex);
          setTimelinePlaying(!timelinePlaying);
        }} aria-label={timelinePlaying ? '暂停回放' : '开始回放'}>{timelinePlaying ? '⏸' : '▶'}</button>
        <button className="timeline-btn" onClick={() => moveTo(safeIndex - 1)} aria-label="上一帧">⏮</button>
        <button className="timeline-btn" onClick={() => moveTo(safeIndex + 1)} aria-label="下一帧">⏭</button>
        {modes.length > 1 && (
          <select className="timeline-mode" value={timelineMode} onChange={(event) => {
            setTimelinePlaying(false);
            setTimelineMode(event.target.value as TimelineMode);
            queueMicrotask(() => applyTimelineFrame(0));
          }} aria-label="回放时间轴模式">
            {modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        )}
        <span className="timeline-file" title={sourceLabel}>{sourceLabel}</span>
      </div>
      <div className="timeline-slider-wrap">
        <span>{formatTimestamp(session?.range?.start ?? null)}</span>
        <input className="timeline-slider" type="range"
          min={session?.range?.start ?? 0} max={session?.range?.end ?? 0} step={1}
          value={currentFrame?.timestamp ?? session?.range?.start ?? 0}
          onChange={(event) => moveTo(nearestFrameIndex(frames, Number(event.target.value)))}
          aria-label="真实时间轴进度" />
        <span>{formatTimestamp(session?.range?.end ?? null)}</span>
      </div>
      <div className="timeline-right">
        <span className="timeline-time">{formatTimestamp(currentFrame?.timestamp ?? null)}</span>
        <span className="timeline-pos">{safeIndex + 1} / {frames.length}</span>
        {timelineMode === 'combined' && <span className="timeline-sync-info">±{(currentFrame?.maxDistanceMs ?? 0) / 1000}s · 排除 {session?.rejectedAnchorCount ?? 0}</span>}
        <div className="timeline-speeds">
          {[1, 60, 120, 600].map((speed) => (
            <button key={speed} className={`timeline-speed ${timelineSpeed === speed ? 'active' : ''}`}
              onClick={() => setTimelineSpeed(speed)}>{speed}×</button>
          ))}
        </div>
        {controlMode === 'replay'
          ? <button className="timeline-exit" onClick={exitReplay}>切到手控</button>
          : <button className="timeline-exit" onClick={() => applyTimelineFrame(safeIndex)}>恢复回放</button>}
        <button className="timeline-clear" onClick={clearInjectionDataset}>清除</button>
      </div>
    </div>
  );
}
