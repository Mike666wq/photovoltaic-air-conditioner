import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { experimentApi } from '../services/experimentRealtimeApi';
import { ExperimentRealtimeController } from '../services/experimentRealtimeController';
import { experimentCatalog, experimentTime, pointStatus, latestExperimentSamples, experimentTrendKey, buildExperimentTrendLines } from '../services/experimentRealtimeTypes';
import { sourceLabel } from '../services/realtimeSource';
import { useExperimentRealtimeStore as store } from '../store/experimentRealtime';
import { MonitoringTrendChart } from '../components/bmsRealtime/MonitoringTrendChart';
import type { BmsDevice, BmsIdentity } from '../services/bmsRealtimeTypes';
import './bms-realtime.css';
import './experiment-realtime.css';

const groups = ['温度', '实验电表', '市电', '太阳能', '运行状态', '诊断'];
export interface ExperimentRealtimePageProps {
  embedded?: boolean; identity?: BmsIdentity; device?: BmsDevice | null; autostart?: boolean; pageId?: string;
  onUnauthorized?: () => void; onPermissionRevoked?: (deviceId: string) => void;
}
export function ExperimentRealtimePage(props: ExperimentRealtimePageProps = {}) {
  if (!props.identity || !props.device) return <Navigate to="/monitoring?view=devices&module=experiment" replace />;
  return <ExperimentObservation {...props} identity={props.identity} device={props.device} />;
}
function ExperimentObservation({ identity, device, autostart, pageId, onUnauthorized, onPermissionRevoked }: ExperimentRealtimePageProps & { identity: BmsIdentity; device: BmsDevice }) {
  const state = store(), controller = useRef(new ExperimentRealtimeController()), resume = useRef(false), initialized = useRef(false);
  const [now, setNow] = useState(Date.now()), [mono, setMono] = useState(performance.now()), [clearing, setClearing] = useState(false);
  const currentDevice = state.devices.find(d => d.deviceId === device.deviceId) ?? device;
  const online = !!currentDevice.online && !!currentDevice.lastHeartbeatAt && now - Date.parse(currentDevice.lastHeartbeatAt) < 45000;
  const watching = ['connecting', 'watching', 'reconnecting'].includes(state.phase);
  const samples = latestExperimentSamples(Object.values(state.samples)).filter(s => now - Date.parse(s.receivedAt) < 3600000);
  const byEquipment = new Map(samples.map(sample => [sample.snapshot.equipmentId, sample]));
  const goodCount = samples.flatMap(s => s.snapshot.points).filter(p => pointStatus(p, mono).good).length;
  const includesSimulation = samples.some(s => s.snapshot.source === 'simulation');
  const definitions = experimentCatalog.points.filter(p => device.allowedEquipment?.includes(p.equipmentId));
  const selected = definitions.find(p => `${p.equipmentId}/${p.id}` === state.selection) ?? definitions[0];
  const last = samples.reduce<(typeof samples)[number] | undefined>((previous, sample) => !previous || sample.acceptedOrder > previous.acceptedOrder ? sample : previous, undefined);

  useEffect(() => {
    controller.current.setPermissionRevokedHandler(onPermissionRevoked);
    return () => controller.current.setPermissionRevokedHandler(undefined);
  }, [onPermissionRevoked]);
  useEffect(() => {
    if (initialized.current && state.phase === 'unauthorized' && !state.identity) onUnauthorized?.();
  }, [state.identity, state.phase, onUnauthorized]);
  useEffect(() => {
    const current = controller.current, old = store.getState();
    initialized.current = true;
    if (old.deviceId !== device.deviceId || old.identity?.username !== identity.username) old.clearData();
    const first = experimentCatalog.points.find(p => device.allowedEquipment?.includes(p.equipmentId));
    store.setState({ identity, devices: [device], deviceId: device.deviceId, error: '', selection: device.allowedEquipment?.includes(old.selection.split('/')[0]) ? old.selection : first ? `${first.equipmentId}/${first.id}` : 'PLC/T0' });
    resume.current = !!autostart && document.hidden;
    if (autostart && !document.hidden) void current.start(pageId);
    const timer = setInterval(() => { setNow(Date.now()); setMono(performance.now()); }, 1000);
    const visibility = () => {
      if (document.hidden) {
        resume.current = ['connecting', 'watching', 'reconnecting'].includes(store.getState().phase);
        if (resume.current) current.stop('paused');
      } else if (resume.current) { resume.current = false; void current.start(pageId); }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); resume.current = false; current.stop(); };
  }, [device.deviceId, identity.username, autostart, pageId]);

  const trend = (definition: typeof experimentCatalog.points[number]) => {
    const selection = `${definition.equipmentId}/${definition.id}`;
    const unit = byEquipment.get(definition.equipmentId)?.snapshot.points.find(p => p.id === definition.id)?.unit ?? definition.metadata.Unit;
    const points = state.trendByPoint[experimentTrendKey(device.deviceId, selection)] ?? [];
    return <MonitoringTrendChart title={`${definition.metadata.Label} · ${definition.id}`} unit={unit} series={buildExperimentTrendLines(selection, unit, points)} />;
  };
  const status = state.phase === 'paused' ? '观看已暂停' : state.phase === 'unauthorized' ? '观看权限失效' : state.phase === 'reconnecting' ? '网站连接中断，正在重连' : state.phase === 'connecting' ? '正在建立观看' : !watching ? '未连接观看' : !online ? '本地程序未在线 / 等待本地程序' : `当前有 ${goodCount} 个有效观测点`;
  return <section className="experiment-page" aria-label="实验设备实时观测">
    <p className="bms-notice">只读观测 · 本地程序负责采集与记录，网页不控制设备。心跳在线不代表采集正常。</p>
    {state.error && <p className="bms-error" role="alert">{state.error}</p>}
    <section className="bms-toolbar" aria-label="实验观看设置">
      {watching ? <button onClick={() => { resume.current = false; controller.current.stop(); }}>暂停观测</button> : <button className="bms-primary" disabled={state.phase === 'unauthorized'} onClick={() => void controller.current.start(pageId)}>开始观测</button>}
    </section>
    <section className={`bms-status ${online && watching && goodCount ? 'is-fresh' : ''}`} aria-live="polite">
      <div className="bms-status-title"><strong>{status}</strong>{includesSimulation && <span className="bms-simulation">包含模拟数据</span>}</div>
      <div className="bms-status-grid"><div><span>网站数据连接</span><b>{state.websiteConnected ? '已连通' : '未连通'}</b></div><div><span>采集端心跳</span><b>{online ? '在线' : '未在线'}</b><small>{experimentTime(currentDevice.lastHeartbeatAt)}</small></div><div><span>观看租约</span><b>{state.lease ? '已建立' : '未建立'}</b><small>{experimentTime(state.lease?.expiresAt)}</small></div><div><span>最后快照组装时间</span><b>{experimentTime(last?.snapshot.capturedUtc)}</b><small>逐点时间见测点卡片</small></div></div>
      <p>逐仪器自动跟随最新来源。每点超过30秒标旧数据；通常等待下一次心跳，约15秒加网络耗时。</p>
      {samples.map(sample => <p key={sample.snapshot.equipmentId}>{sample.snapshot.equipmentId}：{sourceLabel(sample.snapshot.source)}</p>)}
    </section>
    {last && Math.abs(Date.parse(last.snapshot.capturedUtc) - Date.parse(last.receivedAt)) > 60000 && <p className="bms-warning">采集机与服务器时间可能有偏差，请核对系统时钟。</p>}
    <div className="experiment-group-links" aria-label="测点分组">{groups.filter(group => definitions.some(p => p.metadata.Group === group)).map(group => <a key={group} href={`#experiment-${group}`}>{group}</a>)}</div>
    <section className="bms-trends" aria-label="温度与太阳能趋势">{definitions.filter(p => p.metadata.Group === '温度' || p.metadata.Group === '太阳能').map(def => <div key={`${def.equipmentId}/${def.id}`}>{trend(def)}</div>)}</section>
    {groups.filter(group => definitions.some(p => p.metadata.Group === group)).map(group => <section key={group} id={`experiment-${group}`} className="experiment-group">
      <h2>{group}</h2><div className="experiment-point-grid">{definitions.filter(p => p.metadata.Group === group).map(def => {
        const sample = byEquipment.get(def.equipmentId), point = sample?.snapshot.points.find(p => p.id === def.id), view = pointStatus(point, mono);
        const history = sample && state.lastGoodByPoint[`${sample.snapshot.source}/${def.equipmentId}/${def.id}`];
        return <article key={`${def.equipmentId}/${def.id}`} className={`experiment-point ${view.good ? '' : 'is-muted'}`} data-point-id={def.id}>
          <header><h3>{def.metadata.Label}</h3><code>{def.id}</code></header>
          <div className="experiment-point-value"><strong>{view.value}</strong><span>{point?.unit ?? def.metadata.Unit}</span></div>
          <p className={view.good ? 'experiment-quality' : 'experiment-quality is-warning'}>{view.label}{!def.metadata.ScaleConfirmed && <span> · 倍率待核准</span>}</p>
          <small>{def.equipmentId} · 站号 {def.slave} · {sourceLabel(sample?.snapshot.source)}</small>
          <p className="experiment-point-time">观测：{experimentTime(point?.observedUtc)}</p>
          {!view.good && history && <p>最后有效历史值：{history.value ?? history.displayValue} {history.unit} · {sourceLabel(sample?.snapshot.source)} · {experimentTime(history.observedUtc)}（非当前读数）</p>}
          {point && <details><summary>原始值与寄存器信息</summary><p>原始值：{point.rawValue ?? '—'}；客户端显示：{point.displayValue || '—'}</p><p>质量：{point.quality}；轮次：{point.acquisitionRound}；配置：{point.configVersion}</p><p>接收：{experimentTime(point.receivedAt)}；零基地址：{def.addressZeroBased}；寄存器数：{def.registerCount}；解码：{point.decodeMode}</p>{view.stale && <p>历史观测值：{point.value ?? point.displayValue} {point.unit}（旧数据，非当前读数）</p>}</details>}
        </article>;
      })}</div>
    </section>)}
    {selected && <section className="experiment-trend"><label>短趋势测点<select value={`${selected.equipmentId}/${selected.id}`} onChange={event => { const selection = event.target.value; store.setState({ selection, trend: state.trendByPoint[experimentTrendKey(device.deviceId, selection)] ?? [] }); void controller.current.refreshTrend(); }}>{definitions.map(p => <option key={`${p.equipmentId}/${p.id}`} value={`${p.equipmentId}/${p.id}`}>{p.equipmentId} · {p.id} · {p.metadata.Label}</option>)}</select></label>{trend(selected)}<p>完整保留最近一小时；曲线按逐点时间绘制，来源、会话、失败和数据空档为断点，倍率不重复转换。</p></section>}
    <footer className="bms-footer"><span>完整记录、串口配置和导出由本地客户端负责。</span>{state.capacityWarning && <span className="bms-warning">缓存容量不足，新观测已被拒绝；已有历史仍保留。</span>}{identity.role === 'admin' && (clearing ? <div><span>清理当前设备的短缓存？</span><button onClick={async () => { try { await experimentApi.clear(device.deviceId); store.getState().clearData(); setClearing(false); } catch (error) { store.setState({ error: (error as Error).message }); } }}>确认清理</button><button onClick={() => setClearing(false)}>取消</button></div> : <button onClick={() => setClearing(true)}>清理设备短缓存</button>)}</footer>
  </section>;
}
