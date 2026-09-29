import { useEffect, useRef, type RefObject } from 'react';
import type { SimulationState } from '../store/simulation';

/** 缓存的 SVG 节点引用（避免每帧 querySelector） */
interface PanelGroups {
  left: SVGGElement | null;
  mid: SVGGElement | null;
  right: SVGGElement | null;
}

interface Nodes {
  /** pv-array 的 <g> 根；缓存它是为了避免每帧对整棵子树做 querySelector。 */
  root: SVGGElement | null;
  sun: SVGGElement | null;
  cone: SVGPolygonElement | null;
  groups: PanelGroups;
}

/** 旧实现每个 60Hz 帧推进 0.012rad，换算为与刷新率无关的 rad/s。 */
const SUN_RADIANS_PER_SECOND = 0.012 * 60;

const EMPTY_NODES: Nodes = {
  root: null,
  sun: null,
  cone: null,
  groups: { left: null, mid: null, right: null },
};

/**
 * 复制 demo.html:1255-1310 的 PV 太阳 RAF 动画（保持数值公式不变）。
 *
 * 每帧：
 *   1. 太阳按正弦扫过（sin(sunAngle - π/2)），pv_sun 控制速度；
 *   2. 抛物线 y = 0.00756 (x-120)² + 30 控制高度；
 *   3. 更新 #pv-light-cone 的 points 与透明度；
 *   4. 三组面板按距离衰减 brightness + glow filter + data-sun-illuminated。
 *
 * 非 PV 部件槽位：svgRef.current 内查不到 #pv-sun，tick 提前 return（不影响其它部件）。
 */
export function usePvSunAnimation(
  svgRef: RefObject<SVGSVGElement>,
  state: SimulationState,
  /**
   * 是否为本 PV 槽位。
   *
   * 此前本 hook 在每个 ComponentSlot 各调一次（13 个槽 = 13 条常驻 rAF），
   * 其中 12 条每帧对整棵子树 querySelector('[data-component-id="pv-array"]')
   * 后 return —— 实测动画开启且画面完全静止时主线程仍有 44% 占用、每秒 60 次 style+layout。
   * 现在非 PV 槽位根本不注册循环。
   */
  enabled: boolean = true,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const nodesRef = useRef<Nodes>(EMPTY_NODES);
  /**
   * 上次写入 DOM 的值。
   *
   * 光伏不发电时每帧都会把同一组 opacity/filter/data-sun-illuminated 再写一遍
   * （27 次/帧组的无效写），白白触发 style/layout 重算 —— 实测占主线程 46%、
   * 每秒 60 次 StyleRecalc+Layout。值没变就不写。
   */
  const lastWrittenRef = useRef<Record<string, string>>({});

  // 缓存 SVG 节点：mount/卸载时刷新一次（svgRef.current 引用变化触发）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      nodesRef.current = EMPTY_NODES;
      return;
    }
    const root = svg.querySelector<SVGGElement>('[data-component-id="pv-array"]');
    if (!root) {
      nodesRef.current = EMPTY_NODES;
      return;
    }
    nodesRef.current = {
      root,
      sun: root.querySelector<SVGGElement>('#pv-sun'),
      cone: root.querySelector<SVGPolygonElement>('#pv-light-cone'),
      groups: {
        left: root.querySelector<SVGGElement>('.anim-panel-group-left'),
        mid: root.querySelector<SVGGElement>('.anim-panel-group-mid'),
        right: root.querySelector<SVGGElement>('.anim-panel-group-right'),
      },
    };
  }, [svgRef.current]);

  // RAF 循环（镜像 useParticleAnimation.ts:106-161 的生命周期）
  // 依赖里带上 animationOn：关闭时循环真正停摆，重新打开时重启。
  useEffect(() => {
    if (!enabled || !stateRef.current.animationOn) return;
    let rafId: number;
    let sunAngle = 0;
    let previousTime: number | null = null;

    const tick = (now: number) => {
      const s = stateRef.current;
      const deltaSeconds = previousTime == null ? 0 : Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
      previousTime = now;

      // 动画关闭：正常情况下 effect 已停摆；这里兜底处理运行中被翻转的情况。
      if (!s.animationOn) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      // 复用缓存的 root，避免每帧对整棵子树 querySelector。
      // 但必须保留"缓存为空时重新发现"的兜底：SVG 是异步 fetch 后才挂载的，
      // 而上面的节点缓存 effect 依赖 [svgRef.current] —— ref 变化不触发重渲染，
      // 缓存可能一直是空的。只在缓存为空时兜底查一次，命中后即永久走缓存。
      let root = nodesRef.current.root;
      if (!root) {
        const svg = svgRef.current;
        const found = svg?.querySelector<SVGGElement>('[data-component-id="pv-array"]') ?? null;
        if (found) {
          root = found;
          nodesRef.current = {
            root,
            sun: found.querySelector<SVGGElement>('#pv-sun'),
            cone: found.querySelector<SVGPolygonElement>('#pv-light-cone'),
            groups: {
              left: found.querySelector<SVGGElement>('.anim-panel-group-left'),
              mid: found.querySelector<SVGGElement>('.anim-panel-group-mid'),
              right: found.querySelector<SVGGElement>('.anim-panel-group-right'),
            },
          };
          lastWrittenRef.current = {};
        }
      }
      if (!root) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      // 检查缓存是否过期（SVG children 被 innerHTML='' + cloneNode(true) 重建时，
      // 旧节点 detached；root.contains(cached) === false → 重新查询）。
      let { sun, cone, groups } = nodesRef.current;
      if (!sun || !root.contains(sun)) {
        sun = root.querySelector<SVGGElement>('#pv-sun') ?? null;
        cone = root.querySelector<SVGPolygonElement>('#pv-light-cone') ?? null;
        groups = {
          left: root.querySelector<SVGGElement>('.anim-panel-group-left') ?? null,
          mid: root.querySelector<SVGGElement>('.anim-panel-group-mid') ?? null,
          right: root.querySelector<SVGGElement>('.anim-panel-group-right') ?? null,
        };
        nodesRef.current = { root, sun, cone, groups };
        // 节点刚被重建，新节点上没有任何内联样式；必须清空写入缓存，
        // 否则会把"已写过"误判成"值相同"而跳过首次写入，光照/光锥停留在旧状态。
        lastWrittenRef.current = {};
      }

      if (!sun) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const replayPower = s.playbackSnapshot?.values.pv_power
        ?? (s.playbackSnapshot?.values.pv_voltage != null && s.playbackSnapshot?.values.pv_current != null
          ? s.playbackSnapshot.values.pv_voltage * s.playbackSnapshot.values.pv_current / 1000
          : null);
      const pvAvailable = s.controlMode !== 'replay'
        || s.playbackSnapshot?.statusAvailability.pv_on === true;
      const pvRunning = pvAvailable && s.pv_on
        && (s.controlMode === 'replay' ? (replayPower ?? 0) > 0.01 : s.pv_power > 0.01);
      const effectiveSun = s.controlMode === 'replay'
        ? Math.max(0, Math.min(1, (replayPower ?? 0) / 6))
        : Math.max(0, Math.min(1, s.pv_sun));

      if (!pvRunning || effectiveSun <= 0) {
        const last = lastWrittenRef.current;
        if (cone && last.cone !== '0') {
          cone.style.opacity = '0';
          last.cone = '0';
        }
        (['left', 'mid', 'right'] as const).forEach((key) => {
          const group = groups[key];
          if (!group) return;
          if (last[`op_${key}`] !== '0.15') {
            group.style.opacity = '0.15';
            last[`op_${key}`] = '0.15';
          }
          if (last[`fl_${key}`] !== 'none') {
            group.style.filter = 'none';
            last[`fl_${key}`] = 'none';
          }
          if (last[`il_${key}`] !== 'false') {
            group.setAttribute('data-sun-illuminated', 'false');
            last[`il_${key}`] = 'false';
          }
        });
        rafId = requestAnimationFrame(tick);
        return;
      }

      // 太阳自主移动：正弦波平滑扫动
      sunAngle += SUN_RADIANS_PER_SECOND * effectiveSun * deltaSeconds;
      if (sunAngle > Math.PI * 2) sunAngle %= Math.PI * 2;

      // 计算太阳位置：x 从 -30 到 270，y 用抛物线
      const t = (Math.sin(sunAngle - Math.PI / 2) + 1) / 2; // 0~1，从左到右
      const x = -30 + t * 300;
      const y = 0.00756 * (x - 120) * (x - 120) + 30;

      // 1. 设置太阳位置
      const scale = 0.6 + 0.6 * (1 - Math.abs(x - 120) / 150);
      sun.setAttribute('transform', `translate(${x.toFixed(1)}, ${y.toFixed(1)}) scale(${scale.toFixed(2)})`);

      // 2. 更新光锥：从太阳底部向下辐射到面板区域
      if (cone) {
        const coneTopLeft = x - 30;
        const coneTopRight = x + 30;
        const nextPoints = `${coneTopLeft.toFixed(1)},${(y + 20).toFixed(1)} ${coneTopRight.toFixed(1)},${(y + 20).toFixed(1)} 200,200 40,200`;
        const heightFactor = 1 - (y - 30) / 170;
        const nextConeOpacity = (0.1 + heightFactor * 0.3).toFixed(2);
        const last = lastWrittenRef.current;
        if (last.conePoints !== nextPoints) {
          cone.setAttribute('points', nextPoints);
          last.conePoints = nextPoints;
        }
        // 光锥透明度随太阳高度变化
        if (last.coneOpacity !== nextConeOpacity) {
          cone.style.opacity = nextConeOpacity;
          last.coneOpacity = nextConeOpacity;
        }
      }

      // 3. 面板亮度 + 照射状态
      const panelCenters = { left: 65, mid: 120, right: 175 };
      const maxDist = 120;
      (['left', 'mid', 'right'] as const).forEach((key) => {
        const g = groups[key];
        if (!g) return;
        const dist = Math.abs(x - panelCenters[key]);
        const brightness = Math.max(0.15, 1 - dist / maxDist);
        const glowIntensity = Math.max(0, (1 - dist / maxDist) * 0.8);
        const illuminated = dist < 80; // 距离太阳 < 80px 时被照射

        const last = lastWrittenRef.current;
        const nextOpacity = brightness.toFixed(2);
        const nextFilter = glowIntensity > 0.1
          ? `drop-shadow(0 0 ${(glowIntensity * 8).toFixed(1)}px rgba(252, 211, 77, ${glowIntensity.toFixed(2)}))`
          : 'none';
        const nextLit = illuminated ? 'true' : 'false';
        if (last[`op_${key}`] !== nextOpacity) { g.style.opacity = nextOpacity; last[`op_${key}`] = nextOpacity; }
        if (last[`fl_${key}`] !== nextFilter) { g.style.filter = nextFilter; last[`fl_${key}`] = nextFilter; }
        if (last[`il_${key}`] !== nextLit) {
          g.setAttribute('data-sun-illuminated', nextLit);
          last[`il_${key}`] = nextLit;
        }
      });

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // animationOn 进依赖：关闭动画时循环真正停摆（而不是每帧空转续命），
    // 重新打开时重启。仅依赖布尔值，state 每帧变化不会导致 effect 重跑。
  }, [state.animationOn]);
}
