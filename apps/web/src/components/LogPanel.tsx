import { useEffect, useRef } from 'react';
import { useSimStore } from '../store/simulation';
import { derivePcmVisual } from '../engine/pcm';

export function LogPanel() {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => {
      const log = logRef.current;
      if (!log) return;
      const state = useSimStore.getState();
      const time = new Date().toLocaleTimeString();
      const pvStr = state.pv_power.toFixed(2);
      const socStr = Math.round(state.bat_soc);
      const tankStr = Math.round(state.tank_temp);
      const hpState = state.hp_on ? '运行' : '待机';
      const pcm = derivePcmVisual(state);
      const entry = document.createElement('div');
      entry.textContent = `[${time}] PV=${pvStr}kW · SOC=${socStr}% · 水箱=${tankStr}℃ · 热泵=${hpState} · PCM=${pcm.statusText}`;
      log.appendChild(entry);
      while (log.children.length > 20) {
        log.removeChild(log.firstChild!);
      }
      log.scrollTop = log.scrollHeight;
    }, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="log-panel" ref={logRef}>
      <div>[系统就绪] M1 原理图页面启动成功 · 12 部件（2×6）+ 线缆 + Canvas 粒子层</div>
      <div>[提示] 按 Cmd+Shift+R 硬刷新避免 SVG 缓存</div>
    </div>
  );
}