import { useEffect, useMemo, useRef } from 'react';
import { useTimelinePlayback } from '../hooks/useTimelinePlayback';
import {
  useSimStore,
  type TimelineMode,
} from '../store/simulation';
import {
  type PlaybackFrame,
} from '../services/playbackSession';
import {
  applyTimelineFrame,
  getPlaybackSessionForState,
} from '../services/playbackController';
import { configureActiveExperimentSession } from '../services/sessionCoordinator';
export { applyRowToStore, applyTimelineFrame, resolveRowsAtCursor } from '../services/playbackController';

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
  const activePlaybackSourceIds = useSimStore((state) => state.activePlaybackSourceIds);
  const playbackAnchorSourceId = useSimStore((state) => state.playbackAnchorSourceId);
  const playbackToleranceMs = useSimStore((state) => state.playbackToleranceMs);
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
  const stateForSession = useMemo(
    () => useSimStore.getState(),
    [activePlaybackSourceIds, sources, dataset, timelineMode, playbackAnchorSourceId, playbackToleranceMs],
  );
  const session = useMemo(() => getPlaybackSessionForState(stateForSession), [stateForSession]);
  const frames = session?.frames ?? [];
  const maxIndex = Math.max(0, frames.length - 1);
  const safeIndex = Math.max(0, Math.min(timelineIndex, maxIndex));
  const currentFrame = frames[safeIndex] ?? null;
  useTimelinePlayback(frames, timelinePlaying, setTimelinePlaying);

  if (!dataset || !sources.length) return null;
  const hasThermal = sources.some((source) => source.role === 'thermal-electrical' || source.role === 'mixed');
  const hasBms = sources.some((source) => source.role === 'battery-bms' || source.role === 'mixed');
  const activeSources = sources.filter((source) => activePlaybackSourceIds.includes(source.sourceId));
  const modes: Array<{ value: TimelineMode; label: string }> = [
    ...((hasThermal && hasBms) || activeSources.length > 1
      ? [{ value: 'combined' as const, label: '严格同步交集' }]
      : []),
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
        <span>请检查文件时间、异常行与 ±{stateForSession.playbackToleranceMs / 1000} 秒匹配条件。</span>
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
        {timelineMode === 'combined' && activeSources.length > 1 && (
          <>
            <select
              className="timeline-mode"
              value={playbackAnchorSourceId ?? session?.anchorSourceId ?? ''}
              onChange={(event) => {
                configureActiveExperimentSession(event.target.value, playbackToleranceMs);
              }}
              aria-label="主时间轴来源"
              title="主时间轴来源"
            >
              {activeSources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.sourceFile}</option>)}
            </select>
            <select
              className="timeline-mode"
              value={playbackToleranceMs}
              onChange={(event) => {
                configureActiveExperimentSession(playbackAnchorSourceId ?? session?.anchorSourceId ?? '', Number(event.target.value));
              }}
              aria-label="同步容差"
              title="同步容差"
            >
              {[500, 1_000, 2_000, 5_000, 10_000].map((value) => (
                <option key={value} value={value}>±{value / 1_000} 秒</option>
              ))}
            </select>
          </>
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
        {timelineMode === 'combined' && <span className="timeline-sync-info">容差 ±{playbackToleranceMs / 1000}s · 当前偏差 {(currentFrame?.maxDistanceMs ?? 0) / 1000}s · 排除 {session?.rejectedAnchorCount ?? 0}</span>}
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
