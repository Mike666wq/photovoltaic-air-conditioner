import { useAnalysisStore } from '../store/analysis';
import {
  useSimStore,
  type InjectionDataset,
  type SimulationState,
} from '../store/simulation';
import { applyMapping, type NumericFieldKey } from './dataMapper';
import {
  buildPlaybackSession,
  type PlaybackSession,
} from './playbackSession';
import { buildSchematicFrame } from './schematicFrame';

let sessionCache: { key: string; session: PlaybackSession } | null = null;

function sourcesForMode(state: SimulationState): InjectionDataset[] {
  if (!state.injectionSources.length || !state.activePlaybackSourceIds.length) return [];
  const activeIds = new Set(state.activePlaybackSourceIds);
  const activeSources = state.injectionSources.filter((source) => activeIds.has(source.sourceId));
  if (state.timelineMode === 'combined') {
    const relevant = activeSources.filter((source) =>
      source.role === 'thermal-electrical' || source.role === 'mixed' || source.role === 'battery-bms',
    );
    return relevant.length ? relevant : activeSources;
  }
  // 用户明确切换到某一角色时按当前主来源播放单源模式。
  const active = state.injectionDataset;
  if (active && activeIds.has(active.sourceId) && active.role === state.timelineMode) return [active];
  const matched = activeSources.find((source) => source.role === state.timelineMode);
  return matched ? [matched] : [];
}

/** 原理图、时间条和导入入口共享的唯一回放会话构造器。 */
export function getPlaybackSessionForState(state: SimulationState): PlaybackSession | null {
  const sources = sourcesForMode(state);
  if (!sources.length) return null;
  const configuredAnchor = sources.find((source) => source.sourceId === state.playbackAnchorSourceId);
  const anchor = state.timelineMode === 'combined'
    ? configuredAnchor
      ?? sources.find((source) => source.role === 'thermal-electrical' || source.role === 'mixed')
      ?? sources[0]
    : sources[0];
  const toleranceMs = Math.max(0, Math.min(60_000, state.playbackToleranceMs));
  const key = [
    state.timelineMode,
    anchor.sourceId,
    toleranceMs,
    ...sources.map((source) => `${source.sourceId}:${source.injectedAt}`),
  ].join('|');
  if (sessionCache?.key === key) return sessionCache.session;
  const session = buildPlaybackSession({
    sources: sources.map((source) => source.prepared),
    anchorSourceId: anchor.sourceId,
    toleranceMs,
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
  const session = getPlaybackSessionForState(state);
  if (!session?.frames.length || frameIndex < 0) return rows;
  const frame = session.frames[Math.min(frameIndex, session.frames.length - 1)];
  if (cursorMs != null && frame.timestamp !== cursorMs) return rows;
  for (const [sourceId, sample] of Object.entries(frame.samples)) rows.set(sourceId, sample.raw);
  return rows;
}

/** 以 strict-intersection frame 原子更新原理图测量、状态、可用性和来源证据。 */
export function applyTimelineFrame(index: number): boolean {
  const state = useSimStore.getState();
  const session = getPlaybackSessionForState(state);
  if (!session?.frames.length) return false;
  const safeIndex = Math.max(0, Math.min(session.frames.length - 1, index));
  const frame = session.frames[safeIndex];
  const schematic = buildSchematicFrame(frame, state, useAnalysisStore.getState().batteryCurrentConvention);
  useSimStore.setState({
    ...schematic.measurements,
    ...schematic.statuses,
    timelineIndex: safeIndex,
    timelineCursorMs: frame.timestamp,
    injectionFieldAvailability: schematic.measurementAvailability,
    playbackSnapshot: schematic.snapshot,
    controlMode: 'replay',
  });
  return true;
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
