import { useEffect, useRef, useState } from 'react';

interface TooltipData {
  name: string;
  type: string;
  spec: string;
  rating: string;
}

const TOOLTIP_DATA: Record<string, TooltipData> = {
  'pv-array':      { name: '光伏阵列',     type: '太阳能发电设备',     spec: '5 kWp',    rating: 'DC 5kWp · 6 块板' },
  'combiner-box':  { name: '汇流箱',       type: '直流汇集设备',       spec: '1000V/32A', rating: 'DC 1000V · 32A' },
  'grid':          { name: '电网',         type: '公共电网',           spec: '380V/220V', rating: 'AC 380V/220V · 50Hz' },
  'grid-switch':   { name: '并网开关',     type: '并网隔离开关',       spec: '100A',     rating: '额定电流 100A' },
  'inverter':      { name: '双向逆变器',   type: 'DC ⇄ AC 变流器',     spec: '10 kW',    rating: 'DC ⇄ AC · 10 kW' },
  'battery':       { name: '蓄电池',       type: '磷酸铁锂储能',       spec: '10 kWh',   rating: '容量 10 kWh · SOC' },
  'load':          { name: '室内用电',     type: '终端负载',           spec: '0.62 kW',  rating: '实时功率 0.62 kW' },
  'heat-pump':     { name: '热泵机组',     type: '空气源热泵',         spec: '8 kW',     rating: 'COP 3.8 · 制冷/制热' },
  'tank':          { name: '水箱（盘管）', type: '蓄热水箱',           spec: '300L',     rating: '容量 300L + 盘管' },
  'pump':          { name: '循环水泵',     type: '离心泵',             spec: '0.75kW',   rating: 'H=3m · 流量可调' },
  'pcm':           { name: '相变材料',     type: '相变蓄能',           spec: 'PCM 50kg', rating: '融化/凝固 0~50℃' },
  'air-terminal':  { name: '末端风盘',     type: '风机盘管',           spec: '3 台',     rating: '送风温度可调' },
  'power-meter':   { name: '功率检测器',   type: '电参数测量',         spec: '电参数',   rating: '实时功率 · 趋势' },
  'temp-sensor':   { name: '温度检测器',   type: '温度变送器',         spec: 'PT100',    rating: '范围 0~100℃' },
};

export function Tooltip() {
  const [state, setState] = useState<{ visible: boolean; x: number; y: number; data: TooltipData | null }>({
    visible: false, x: 0, y: 0, data: null,
  });
  const timerRef = useRef<number | null>(null);
  const visibleRef = useRef(false);

  useEffect(() => {
    const onEnter = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target) return;
      const slot = target.closest('.component-slot');
      if (!slot) return;
      // 找到对应的部件 ID（component-slot 上有 data-component-id）
      const id = slot.getAttribute('data-component-id');
      if (!id || !TOOLTIP_DATA[id]) return;
      const data = TOOLTIP_DATA[id];
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        visibleRef.current = true;
        setState({ visible: true, x: e.clientX, y: e.clientY, data });
      }, 200);
    };

    const onMove = (e: MouseEvent) => {
      if (visibleRef.current) {
        setState((s) => (s.visible ? { ...s, x: e.clientX, y: e.clientY } : s));
      }
    };

    const onLeave = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      visibleRef.current = false;
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    };

    document.addEventListener('mouseover', onEnter);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseout', onLeave);
    return () => {
      document.removeEventListener('mouseover', onEnter);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onLeave);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      className={`component-tooltip ${state.visible ? 'visible' : ''}`}
      style={{ left: state.x + 12, top: state.y + 12 }}
    >
      {state.data && (
        <>
          <div className="tt-name">{state.data.name}</div>
          <div className="tt-type">{state.data.type}</div>
          <div className="tt-row"><span className="tt-label">规格</span><span className="tt-value">{state.data.spec}</span></div>
          <div className="tt-row"><span className="tt-label">额定</span><span className="tt-value">{state.data.rating}</span></div>
        </>
      )}
    </div>
  );
}