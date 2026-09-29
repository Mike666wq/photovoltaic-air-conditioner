import { useEffect, useRef, RefObject } from 'react';
import { SimulationState } from '../store/simulation';
import { deriveCableSegmentFlow } from '../engine/schematicControl';
import type { ResolvedCablePath } from '../engine/orthogonalRouter';
import { advanceParticleDistance, polylineLength } from '../engine/particleMotion';

interface ParticleState {
  cableId: string;
  segmentIndex: number;
  distance: number;
  particles: Array<{ el: SVGCircleElement; phase: number }>;
}

interface SegmentPoint { x: number; y: number; }

/** 路径 t∈[0,1] 处的点 */
function pointAtPath(pts: SegmentPoint[], t: number): SegmentPoint {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];

  const filteredPts: SegmentPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) >= 0.001) {
      filteredPts.push(pts[i]);
    }
  }

  if (filteredPts.length === 0) return pts[0] ?? { x: 0, y: 0 };
  if (filteredPts.length === 1) return filteredPts[0];

  let totalLen = 0;
  for (let i = 1; i < filteredPts.length; i++) {
    totalLen += Math.hypot(filteredPts[i].x - filteredPts[i - 1].x, filteredPts[i].y - filteredPts[i - 1].y);
  }
  const target = t * totalLen;
  let acc = 0;
  for (let i = 1; i < filteredPts.length; i++) {
    const segLen = Math.hypot(filteredPts[i].x - filteredPts[i - 1].x, filteredPts[i].y - filteredPts[i - 1].y);
    if (acc + segLen >= target) {
      const local = (target - acc) / segLen;
      return {
        x: filteredPts[i - 1].x + (filteredPts[i].x - filteredPts[i - 1].x) * local,
        y: filteredPts[i - 1].y + (filteredPts[i].y - filteredPts[i - 1].y) * local,
      };
    }
    acc += segLen;
  }
  return filteredPts[filteredPts.length - 1];
}

// 粒子颜色
export const PARTICLE_STYLE: Record<string, { main: string; edge: string }> = {
  power:       { main: '#FCD34D', edge: '#FEF3C7' },
  refrigerant: { main: '#5EEAD4', edge: '#FFFFFF' },
  water:       { main: '#93C5FD', edge: '#FFFFFF' },
};

export function useParticleAnimation(
  particleLayerRef: RefObject<SVGGElement>,
  state: SimulationState,
  resolveRoutes: (cable: SimulationState['cables'][number]) => ResolvedCablePath[],
  zoom: number,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const resolveRoutesRef = useRef(resolveRoutes);
  resolveRoutesRef.current = resolveRoutes;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const cableStatesRef = useRef<Map<string, ParticleState>>(new Map());

  const syncParticleRefs = () => {
    const layer = particleLayerRef.current;
    if (!layer) return;
    const grouped = new Map<string, Array<{ el: SVGCircleElement; index: number }>>();
    layer.querySelectorAll<SVGCircleElement>('circle[data-particle-key]').forEach((circle) => {
      const cableId = circle.dataset.cableId;
      const segmentIndex = Number(circle.dataset.segmentIndex);
      const particleIndex = Number(circle.dataset.particleIndex);
      if (!cableId || !Number.isInteger(segmentIndex) || !Number.isInteger(particleIndex)) return;
      const key = `${cableId}:${segmentIndex}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push({ el: circle, index: particleIndex });
    });
    cableStatesRef.current.clear();
    stateRef.current.cables.forEach((cable) => cable.segments.forEach((_, segmentIndex) => {
      const key = `${cable.id}:${segmentIndex}`;
      const registered = (grouped.get(key) ?? []).sort((a, b) => a.index - b.index);
      cableStatesRef.current.set(key, {
        cableId: cable.id,
        segmentIndex,
        distance: 0,
        particles: registered.map(({ el, index }) => ({ el, phase: index / 8 })),
      });
    }));
  };

  // 同步线缆列表与粒子
  useEffect(() => {
    const layer = particleLayerRef.current;
    if (!layer) return;

    syncParticleRefs();

    return () => cableStatesRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    particleLayerRef,
    state.cables.map((c) =>
      `${c.id}|${c.kind}|${c.floatingFrom?.x ?? ''},${c.floatingFrom?.y ?? ''}|${c.floatingTo?.x ?? ''},${c.floatingTo?.y ?? ''}|${c.segments.map((s) => `${s.fromAnchorId}>${s.toAnchorId}`).join(',')}|${c.routeMode ?? ''}|${c.manualWaypoints?.map((p) => `${p.x},${p.y}`).join(';') ?? ''}`
    ).join('\0'),
  ]);

  // RAF 循环：使用真实 deltaTime，避免 Safari 60/120Hz 速度不同。
  useEffect(() => {
    if (!state.animationOn) {
      // 关闭动画：确保粒子不可见，并让循环不再启动。
      // 粒子层虽有 display:none，但内联 opacity 需在重新打开前清掉，
      // 否则重新打开的第一帧会闪一下旧位置。
      particleLayerRef.current?.querySelectorAll<SVGCircleElement>('circle[data-particle-key]')
        .forEach((circle) => { circle.style.opacity = '0'; });
      return;
    }
    let rafId: number;
    let previousTime: number | null = null;
    const tick = (now: number) => {
      const s = stateRef.current;
      const expectedSegments = s.cables.reduce((sum, cable) => sum + cable.segments.length, 0);
      const registeredParticles = [...cableStatesRef.current.values()].reduce((sum, item) => sum + item.particles.length, 0);
      if (cableStatesRef.current.size !== expectedSegments || registeredParticles !== expectedSegments * 8) {
        syncParticleRefs();
      }
      const deltaSeconds = previousTime == null ? 0 : Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
      previousTime = now;

      // 动画关闭：粒子隐藏 + 不推进
      if (!s.animationOn) {
        cableStatesRef.current.forEach((cs) => cs.particles.forEach((p) => (p.el.style.opacity = '0')));
        rafId = requestAnimationFrame(tick);
        return;
      }

      s.cables.forEach((cable) => {
        const paths = resolveRoutesRef.current(cable);
        paths.forEach(({ segmentIndex, points: path }) => {
          const cs = cableStatesRef.current.get(`${cable.id}:${segmentIndex}`);
          if (!cs) return;
          const flow = deriveCableSegmentFlow(cable, segmentIndex, s);
          if (path.length < 2 || !flow.active) {
            cs.particles.forEach((p) => {
              p.el.style.opacity = '0';
              p.el.dataset.flowReason = path.length < 2 ? 'data-unavailable' : flow.reason;
            });
            return;
          }
          const pathLength = polylineLength(path);
          if (pathLength <= 0.001) {
            cs.particles.forEach((particle) => {
              particle.el.style.opacity = '0';
              particle.el.dataset.flowReason = 'data-unavailable';
            });
            return;
          }
          const safeZoom = Math.max(0.2, zoomRef.current);
          cs.distance = advanceParticleDistance(cs.distance, flow.pixelsPerSecond, deltaSeconds * 1000, safeZoom, pathLength);
          cs.particles.forEach((particle) => {
            const forwardDistance = (cs.distance + particle.phase * pathLength) % pathLength;
            const distance = flow.direction === 'reverse' ? pathLength - forwardDistance : forwardDistance;
            const t = distance / pathLength;
            const point = pointAtPath(path, t);
            particle.el.setAttribute('cx', String(point.x));
            particle.el.setAttribute('cy', String(point.y));
            particle.el.setAttribute('r', String((cable.kind === 'power' ? 3 : 2.5) / safeZoom));
            particle.el.setAttribute('stroke-width', String(0.5 / safeZoom));
            particle.el.dataset.flowDirection = flow.direction;
            particle.el.dataset.flowReason = flow.reason;
            let opacity = 1;
            if (t < 0.08) opacity = t / 0.08;
            else if (t > 0.92) opacity = (1 - t) / 0.08;
            particle.el.style.opacity = String(opacity);
          });
        });
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // animationOn 进依赖：关闭动画时循环真正停摆。
    // .particle-layer 在 styles.css 中已 display:none，此时每帧仍在遍历线缆与粒子写 style，
    // 纯属浪费（实测动画关仍有 rAF 空转）。
  }, [state.animationOn]);
}
