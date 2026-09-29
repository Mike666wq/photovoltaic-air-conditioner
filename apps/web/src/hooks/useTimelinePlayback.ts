import { useEffect, useRef } from 'react';
import { useSimStore } from '../store/simulation';
import { applyTimelineFrame } from '../services/playbackController';

interface PlaybackFrameLike {
  timestamp: number;
}

/**
 * 时序回放驱动循环：按真实时间戳推进，倍速作用于"仿真游标"而非帧数。
 *
 * 原本只有 TimelineControls 内联一份；大屏页需要同样的播放能力时，
 * 复制第二份必然随时间分叉，因此抽成共享 hook。
 */
export function useTimelinePlayback(
  frames: PlaybackFrameLike[],
  timelinePlaying: boolean,
  setTimelinePlaying: (value: boolean) => void,
) {
  const maxIndex = Math.max(0, frames.length - 1);
  const rafRef = useRef<number | null>(null);
  const lastWallTimeRef = useRef(0);
  const simulatedCursorRef = useRef(0);

  useEffect(() => {
    if (!timelinePlaying || !frames.length) return;
    lastWallTimeRef.current = performance.now();
    simulatedCursorRef.current = frames[
      Math.max(0, Math.min(useSimStore.getState().timelineIndex, maxIndex))
    ].timestamp;

    const tick = (now: number) => {
      const elapsedMs = now - lastWallTimeRef.current;
      lastWallTimeRef.current = now;
      // 倍速乘在时间游标上：60× 表示 1 秒真实时间推进 60 秒采样时间
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
}
