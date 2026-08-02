import { useEffect, useRef, RefObject } from 'react';
import { SimulationState } from '../store/simulation';

interface ParticleState {
  cableId: string;
  offset: number;
  speed: number;
  particles: Array<{ el: SVGCircleElement; phase: number }>;
}

interface SegmentPoint { x: number; y: number; }

/** 计算线缆所有段拼接后的总路径点序列（按段累加） */
function getCablePath(
  cable: {
    segments: Array<{ fromAnchorId: string; toAnchorId: string }>;
    floatingFrom?: { x: number; y: number } | null;
    floatingTo?: { x: number; y: number } | null;
  },
  getAnchorPos: (anchorId: string) => SegmentPoint | null,
): SegmentPoint[] {
  const pts: SegmentPoint[] = [];
  const DEDUP_EPS = 0.5;
  const segs = cable.segments;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];

    let f = seg.fromAnchorId ? getAnchorPos(seg.fromAnchorId) : null;
    if (i === 0 && !f) f = cable.floatingFrom ?? null;

    let t = seg.toAnchorId ? getAnchorPos(seg.toAnchorId) : null;
    if (i === segs.length - 1 && !t) t = cable.floatingTo ?? null;

    if (f && (pts.length === 0 || Math.hypot(pts[pts.length - 1].x - f.x, pts[pts.length - 1].y - f.y) > DEDUP_EPS)) {
      pts.push(f);
    }
    if (t && (pts.length === 0 || Math.hypot(pts[pts.length - 1].x - t.x, pts[pts.length - 1].y - t.y) > DEDUP_EPS)) {
      pts.push(t);
    }
  }
  return pts;
}

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
const PARTICLE_STYLE: Record<string, { main: string; edge: string }> = {
  power:       { main: '#FCD34D', edge: '#FEF3C7' },
  refrigerant: { main: '#5EEAD4', edge: '#FFFFFF' },
  water:       { main: '#93C5FD', edge: '#FFFFFF' },
};

export function useParticleAnimation(
  particleLayerRef: RefObject<SVGGElement>,
  state: SimulationState,
  getAnchorPos: (anchorId: string) => { x: number; y: number } | null,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const cableStatesRef = useRef<Map<string, ParticleState>>(new Map());

  // 同步线缆列表与粒子
  useEffect(() => {
    const layer = particleLayerRef.current;
    if (!layer) return;

    // 移除旧粒子
    cableStatesRef.current.forEach((cs) => cs.particles.forEach((p) => p.el.remove()));
    cableStatesRef.current.clear();

    state.cables.forEach((cable) => {
      const PARTICLE_COUNT = 10;
      const particles: Array<{ el: SVGCircleElement; phase: number }> = [];
      const style = PARTICLE_STYLE[cable.kind];

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const ns = 'http://www.w3.org/2000/svg';
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('r', String(cable.kind === 'power' ? 3 : 2.5));
        circle.setAttribute('fill', i % 2 === 0 ? style.main : style.edge);
        circle.setAttribute('stroke', style.edge);
        circle.setAttribute('stroke-width', '0.5');
        circle.setAttribute('opacity', '0');
        layer.appendChild(circle);
        particles.push({ el: circle, phase: i / PARTICLE_COUNT });
      }

      cableStatesRef.current.set(cable.id, {
        cableId: cable.id,
        offset: 0,
        speed: 0,
        particles,
      });
    });

    return () => {
      cableStatesRef.current.forEach((cs) => cs.particles.forEach((p) => p.el.remove()));
      cableStatesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    particleLayerRef,
    state.cables.map((c) =>
      `${c.id}|${c.kind}|${c.floatingFrom?.x ?? ''},${c.floatingFrom?.y ?? ''}|${c.floatingTo?.x ?? ''},${c.floatingTo?.y ?? ''}|${c.segments.map((s) => `${s.fromAnchorId}>${s.toAnchorId}`).join(',')}`
    ).join('\0'),
  ]);

  // RAF 循环
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const s = stateRef.current;

      // 动画关闭：粒子隐藏 + 不推进
      if (!s.animationOn) {
        cableStatesRef.current.forEach((cs) => cs.particles.forEach((p) => (p.el.style.opacity = '0')));
        rafId = requestAnimationFrame(tick);
        return;
      }

      s.cables.forEach((cable) => {
        const cs = cableStatesRef.current.get(cable.id);
        if (!cs) return;
        const path = getCablePath(cable, getAnchorPos);
        if (path.length < 2) {
          console.debug('[particles] cable', cable.id, 'has path.length=', path.length, 'segments=', cable.segments.length);
        }
        if (path.length === 0) {
          const mid = {
            x: ((cable.floatingFrom?.x ?? 0) + (cable.floatingTo?.x ?? 0)) / 2,
            y: ((cable.floatingFrom?.y ?? 0) + (cable.floatingTo?.y ?? 0)) / 2,
          };
          cs.particles.forEach((p, i) => {
            const angle = (i / cs.particles.length) * Math.PI * 2;
            const radius = 6;
            p.el.setAttribute('cx', String(mid.x + Math.cos(angle) * radius));
            p.el.setAttribute('cy', String(mid.y + Math.sin(angle) * radius));
            p.el.style.opacity = '0.3';
          });
          return;
        }
        if (path.length === 1) {
          const anchor = path[0];
          cs.particles.forEach((p, i) => {
            const angle = (i / cs.particles.length) * Math.PI * 2;
            const radius = 6;
            p.el.setAttribute('cx', String(anchor.x + Math.cos(angle) * radius));
            p.el.setAttribute('cy', String(anchor.y + Math.sin(angle) * radius));
            p.el.style.opacity = '0.4';
          });
          return;
        }

        // M1.5 Round 9：单线缆动画开关（默认 true 向后兼容）
        const animationEnabled = cable.animationEnabled ?? true;
        if (!animationEnabled) {
          cs.particles.forEach((p) => { p.el.style.opacity = '0'; });
          return;
        }

        let base = 0;
        let multiplier = 1;
        if (cable.kind === 'power') {
          base = s.pv_power / 6;
          multiplier = s.pl_flow / 3;
        } else if (cable.kind === 'refrigerant') {
          base = s.hp_on ? s.hp_power / 8 : 0;
          multiplier = s.rl_flow / 3;
        } else if (cable.kind === 'water') {
          // Fix B7：水泵关停时（pump_on=false）粒子速度归零，与 tank_anim_flow_speed 行为一致
          const effectivePumpFlow = s.pump_on ? s.pump_flow : 0;
          base = effectivePumpFlow / 5;
          multiplier = s.wl_flow / 3;
        }
        const speed = base * multiplier;
        cs.speed = speed;

        if (speed <= 0) {
          cs.particles.forEach((p) => (p.el.style.opacity = '0.35'));
          return;
        }

        cs.offset += speed * 0.005;

        // M1.5 Round 9：方向反转（默认 forward）
        const direction = cable.direction ?? 'forward';

        cs.particles.forEach((p) => {
          const forwardT = ((cs.offset + p.phase) % 1 + 1) % 1;
          const t = direction === 'reverse' ? 1 - forwardT : forwardT;
          const { x, y } = pointAtPath(path, t);
          p.el.setAttribute('cx', String(x));
          p.el.setAttribute('cy', String(y));
          let opacity = 1;
          if (t < 0.1) opacity = t / 0.1;
          else if (t > 0.9) opacity = (1 - t) / 0.1;
          p.el.style.opacity = String(opacity);
        });
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);
}