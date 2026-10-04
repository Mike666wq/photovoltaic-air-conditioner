import { useEffect, useMemo, useRef, useState } from 'react';
import { ExperimentRealtimeController } from '../services/experimentRealtimeController';
import { experimentCatalog, experimentTime, pointStatus } from '../services/experimentRealtimeTypes';
import type { ExperimentPoint, ExperimentSource } from '../services/experimentRealtimeTypes';
import type { BmsDevice, BmsIdentity } from '../services/bmsRealtimeTypes';
import { useExperimentRealtimeStore } from '../store/experimentRealtime';
import { MonitoringTrendChart } from '../components/bmsRealtime/MonitoringTrendChart';

export interface ExperimentMonitoringPanelProps {
  identity: BmsIdentity;
  device: BmsDevice | null;
  source?: ExperimentSource;
  pageId: string;
  autostart?: boolean;
  onUnauthorized?: () => void;
}

function pointText(point: ExperimentPoint | undefined, lastGood: ExperimentPoint | undefined, mono: number) {
  const status = pointStatus(point, mono);
  return { status, historic: lastGood ? (lastGood.value === null ? lastGood.displayValue || '—' : String(lastGood.value)) : '', historicTime: lastGood?.observedUtc };
}

export function ExperimentMonitoringPanel({ identity, device, source: initialSource = 'serial', pageId, autostart = true, onUnauthorized }: ExperimentMonitoringPanelProps) {
  const state = useExperimentRealtimeStore();
  const set = useExperimentRealtimeStore.setState;
  const controller = useRef(new ExperimentRealtimeController());
  const resumeAfterVisibility = useRef(false);
  const hadIdentity = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [mono, setMono] = useState(performance.now());
  const watching = ['connecting', 'watching', 'reconnecting'].includes(state.phase);
  const currentSamples = Object.values(state.samples).filter(sample => sample.snapshot.source === state.source);
  const pointsById = useMemo(() => {
    const entries = new Map<string, ExperimentPoint>();
    for (const sample of currentSamples) for (const point of sample.snapshot.points) entries.set(`${sample.snapshot.equipmentId}/${point.id}`, point);
    return entries;
  }, [currentSamples]);
  const lastSample = currentSamples.slice().sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt))[0];
  const usablePoints = currentSamples.flatMap(s=>s.snapshot.points).filter(p=>pointStatus(p,mono).good);
  const activeDevice=state.devices.find(d=>d.deviceId===device?.deviceId)??device;
  const online = !!activeDevice?.online&&!!activeDevice.lastHeartbeatAt&&now-Date.parse(activeDevice.lastHeartbeatAt)<45000;
  const status = !watching ? state.phase==='paused'?'页面隐藏，观看已暂停':state.phase==='unauthorized'?'观看权限失效':state.phase==='expired'?'观看已结束，正在等待重连':'未连接观看' : state.phase==='reconnecting'?'网站连接中断，正在重连':!online?'本地采集程序未在线 / 等待心跳':usablePoints.length?`当前来源有 ${usablePoints.length} 个有效测点`:'当前来源等待新鲜观测';
  const primaryPoints = experimentCatalog.points.filter(def => (def.metadata.Group === '温度' || def.metadata.Group === '太阳能') && !!activeDevice?.allowedEquipment?.includes(def.equipmentId));
  const secondaryPoints = experimentCatalog.points.filter(def => def.metadata.Group !== '温度' && def.metadata.Group !== '太阳能' && !!activeDevice?.allowedEquipment?.includes(def.equipmentId));
  const secondarySelection = secondaryPoints.some(p=>`${p.equipmentId}/${p.id}`===state.selection)?state.selection:secondaryPoints[0]?`${secondaryPoints[0].equipmentId}/${secondaryPoints[0].id}`:'';
  const chartGroups = useMemo(() => {
    const groups = new Map<string, Array<{id:string;name:string;unit:string;points:Array<{time:string;value:number|null;session:string}>}>>();
    for (const def of primaryPoints) {
      const key = `${state.deviceId}/${state.source}/${def.equipmentId}/${def.id}`;
      const point = pointsById.get(`${def.equipmentId}/${def.id}`);
      const unit = point?.unit || def.metadata.Unit || '单位未知';
      const history = state.trendByPoint[key] ?? [];
      const lines = groups.get(unit) ?? [];
      lines.push({id:key,name:`${def.metadata.Label} · ${def.equipmentId}/${def.id}`,unit,points:history.map(item=>({time:item.observedUtc,value:item.value,session:item.connectionSessionId}))});
      groups.set(unit,lines);
    }
    return [...groups].map(([unit,series])=>({unit,series}));
  }, [primaryPoints, pointsById, state.deviceId, state.source, state.trendByPoint]);

  useEffect(() => {
    const old=useExperimentRealtimeStore.getState();
    const nextId=device?.deviceId??'';
    if(old.deviceId!==nextId||old.source!==initialSource)old.clearData();
    set({identity,devices:device?[device]:[],deviceId:nextId,source:initialSource});
    if(autostart&&device&&!document.hidden)void controller.current.start(pageId);
    else if(autostart&&device&&document.hidden)resumeAfterVisibility.current=true;
    const timer=setInterval(()=>{setNow(Date.now());setMono(performance.now());},1000);
    const visibility=()=>{
      const phase=useExperimentRealtimeStore.getState().phase;
      if(document.hidden){resumeAfterVisibility.current=phase==='connecting'||phase==='watching'||phase==='reconnecting';if(resumeAfterVisibility.current)controller.current.stop('paused');}
      else if(resumeAfterVisibility.current){resumeAfterVisibility.current=false;void controller.current.start(pageId);}
    };
    document.addEventListener('visibilitychange',visibility);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visibility);controller.current.stop();};
  },[identity.username,device?.deviceId,initialSource,autostart,pageId,set]);

  useEffect(()=>{if(state.identity)hadIdentity.current=true;else if(hadIdentity.current){hadIdentity.current=false;onUnauthorized?.();}},[state.identity,onUnauthorized]);
  useEffect(()=>{if(watching&&state.selection)void controller.current.refreshTrendSeries(primaryPoints.map(p=>`${p.equipmentId}/${p.id}`));},[watching,state.selection,state.source,state.deviceId]);

  const changeSource=(source:ExperimentSource)=>{controller.current.stop();resumeAfterVisibility.current=false;useExperimentRealtimeStore.getState().clearData();set({source,error:''});if(!document.hidden&&autostart&&device)void controller.current.start(pageId);};
  const catalogGroups=['实验电表','市电','运行状态','诊断'];
  const renderPoint=(def:typeof experimentCatalog.points[number])=>{
    const point=pointsById.get(`${def.equipmentId}/${def.id}`),lastGood=state.lastGoodByPoint[`${state.source}/${def.equipmentId}/${def.id}`],view=pointText(point,lastGood,mono),unit=point?.unit??lastGood?.unit??def.metadata.Unit;
    return <article key={`${def.equipmentId}/${def.id}`} className={`experiment-point${view.status.good?'':' is-muted'}`} data-point-id={def.id}>
      <header><h3>{def.metadata.Label}</h3><code>{def.id}</code></header>
      <div className="experiment-point-value"><strong>{view.status.value}</strong><span>{unit}</span></div>
      <p className={view.status.good?'experiment-quality':'experiment-quality is-warning'}>{view.status.label}</p>
      <small>{def.equipmentId} · 站号 {def.slave} · {state.source==='serial'?'串口实测':'模拟数据'}</small>
      <p className="experiment-point-time">观测：{experimentTime(point?.observedUtc)}</p>
      {view.historic&&<p className="experiment-point-historic">上次有效值：{view.historic} {unit} · {experimentTime(view.historicTime)}</p>}
      {point&&<details><summary>原始值与寄存器信息</summary><p>原始值：{point.rawValue===null?'—':String(point.rawValue)}；客户端显示：{point.displayValue||'—'}</p><p>质量码：{point.quality}；轮次：{point.acquisitionRound}；配置：{point.configVersion}</p><p>接收：{experimentTime(point.receivedAt)}；零基地址：{def.addressZeroBased}；寄存器数：{def.registerCount}；解码：{point.decodeMode}</p></details>}
    </article>;
  };

  return <section className="experiment-embedded" aria-label="系统实验采集监控">
    <header className="experiment-embedded__head"><div><span className="bms-eyebrow">实验采集 · {activeDevice?.alias??'未绑定'}</span><h2>系统运行总览</h2><p>37 个正式测点按各自时间观测；网页只读，本地客户端负责完整记录。</p></div><div className="experiment-embedded__badges">{state.source==='simulation'&&<strong className="bms-simulation">模拟数据</strong>}<span className={`bms-status-pill ${state.phase==='watching'&&online&&usablePoints.length?'is-fresh':''}`}>{status}</span></div></header>
    <div className="experiment-embedded__controls"><label>协议来源<select value={state.source} onChange={e=>changeSource(e.target.value as ExperimentSource)}><option value="serial">串口实测</option>{activeDevice?.allowSimulation&&<option value="simulation">模拟来源</option>}</select></label><div><span>本地时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}</span><span>最后快照：{experimentTime(lastSample?.snapshot.capturedUtc)}</span><span>{state.websiteConnected?'网站已连接':'网站未连接'}</span></div></div>
    {state.error&&<p className="bms-error" role="alert">{state.error}</p>}{state.capacityWarning&&<p className="bms-warning" role="status">缓存容量不足，部分新观测已被拒绝；已有历史仍保留，请管理员检查容量。</p>}
    {!device&&<p className="bms-notice">尚未绑定实验采集设备；BMS 通道不受影响。</p>}
    <section className="experiment-priority"><div><h3>七路温度</h3><div className="experiment-priority__grid">{experimentCatalog.points.filter(def=>def.metadata.Group==='温度'&&activeDevice?.allowedEquipment?.includes(def.equipmentId)).map(renderPoint)}</div></div><div><h3>太阳能观测</h3><div className="experiment-priority__grid experiment-priority__grid--solar">{experimentCatalog.points.filter(def=>def.metadata.Group==='太阳能'&&activeDevice?.allowedEquipment?.includes(def.equipmentId)).map(renderPoint)}</div></div></section>
    <section className="experiment-embedded__trends"><h3>一小时趋势 · 按物理单位分图</h3>{chartGroups.map(group=><MonitoringTrendChart key={group.unit} title={group.unit==='℃'?'七路温度':`太阳能 · ${group.unit}`} unit={group.unit} series={group.series} emptyText="等待有效观测后显示趋势" />)}</section>
    <section className="experiment-embedded__secondary"><h3>其他测点</h3>{catalogGroups.map(group=><details key={group}><summary>{group} · {experimentCatalog.points.filter(p=>p.metadata.Group===group&&activeDevice?.allowedEquipment?.includes(p.equipmentId)).length} 点</summary><div className="experiment-point-grid">{experimentCatalog.points.filter(p=>p.metadata.Group===group&&activeDevice?.allowedEquipment?.includes(p.equipmentId)).map(renderPoint)}</div></details>)}<details><summary>其他物理量趋势</summary><label>选择测点<select value={secondarySelection} onChange={event=>{const selection=event.target.value;set({selection});if(watching)void controller.current.refreshTrendSeries([selection]);}}>{secondaryPoints.map(p=><option key={`${p.equipmentId}/${p.id}`} value={`${p.equipmentId}/${p.id}`}>{p.metadata.Label} · {p.metadata.Unit} · {p.equipmentId}/{p.id}</option>)}</select></label>{(()=>{const def=secondaryPoints.find(p=>`${p.equipmentId}/${p.id}`===secondarySelection);if(!def)return <p>没有可查看的其他测点。</p>;const key=`${state.deviceId}/${state.source}/${def.equipmentId}/${def.id}`,unit=pointsById.get(`${def.equipmentId}/${def.id}`)?.unit||def.metadata.Unit||'单位未知',points=state.trendByPoint[key]??[];return <MonitoringTrendChart title={`${def.metadata.Label} · ${def.equipmentId}/${def.id}`} unit={unit} series={[{id:key,name:`${def.metadata.Label} · ${def.equipmentId}/${def.id}`,unit,points:points.map(p=>({time:p.observedUtc,value:p.value,session:p.connectionSessionId}))}]} emptyText="选择测点后加载一小时历史观测"/>;})()}</details></section>
    <footer className="bms-footer"><span>显示客户端工程值与原始值，不进行额外倍率换算；未知状态按原码显示。</span>{state.identity?.role==='admin'&&device&&<span>缓存 {state.cacheStatus?`${state.cacheStatus.usedPoints}/${state.cacheStatus.maxPoints} 点`:'读取中'}</span>}</footer>
  </section>;
}
