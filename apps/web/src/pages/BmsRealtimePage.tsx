import { isClientForeground, subscribeClientForeground } from '../services/clientForeground';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { bmsApi, BmsApiError } from '../services/bmsRealtimeApi';
import { BmsRealtimeController } from '../services/bmsRealtimeController';
import { bmsTime, bmsNumber, clockSkew, bmsChannelKey, latestBmsSamples, sampleStale, sampleExpired } from '../services/bmsRealtimeTypes';
import { useBmsRealtimeStore } from '../store/bmsRealtime';
import { BmsTrendChart } from '../components/bmsRealtime/BmsTrendChart';
import { DeploymentVersion } from '../components/DeploymentVersion';
import type { BmsSetupStatus } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsIdentity } from '../services/bmsRealtimeTypes';
import { sourceLabel } from '../services/realtimeSource';
import './bms-realtime.css';

export interface BmsRealtimePageProps { embedded?: boolean; identity?: BmsIdentity; device?: BmsDevice | null; autostart?: boolean; pageId?:string; onUnauthorized?:()=>void; onPermissionRevoked?:(deviceId:string)=>void }
export function BmsRealtimePage({ embedded = false, identity: embeddedIdentity, device: embeddedDevice, autostart = false, pageId, onUnauthorized, onPermissionRevoked }: BmsRealtimePageProps = {}) {
  const state = useBmsRealtimeStore();
  const controller = useRef(new BmsRealtimeController());
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [clearing, setClearing] = useState(false);
  const [setup, setSetup] = useState<BmsSetupStatus | null>(null);
  const hadEmbeddedIdentity = useRef(false);
  const resumeAfterVisibility = useRef(false);
  const device = embedded ? state.devices.find((d)=>d.deviceId===embeddedDevice?.deviceId) ?? embeddedDevice ?? undefined : state.devices.find((d) => d.deviceId === state.deviceId);
  const activeDevice = device;
  const heartbeatOnline = !!activeDevice?.online && !!activeDevice.lastHeartbeatAt && now - Date.parse(activeDevice.lastHeartbeatAt) < 45000;
  const currentSamples = latestBmsSamples(state.samples).filter(s => s.snapshot.pack === state.pack);
  const cachedSample = currentSamples.find(s => bmsChannelKey(s.snapshot) === state.channel);
  const includesSimulation = currentSamples.some(s => !sampleExpired(s, now) && s.snapshot.source === 'simulation');
  const cacheExpired = cachedSample ? sampleExpired(cachedSample, now) : false;
  const sample = cacheExpired ? undefined : cachedSample;
  const snapshot = sample?.snapshot;
  const watching = ['connecting', 'watching', 'reconnecting'].includes(state.phase);
  const stale = sample ? sampleStale(sample, now) : false;
  const status = state.phase === 'idle' ? '未连接观看' : state.phase === 'paused' ? '页面隐藏，观看已暂停' : state.phase === 'unauthorized' ? '观看权限失效' : state.phase === 'expired' ? '观看已过期，请重新连接' : state.phase === 'connecting' ? '正在建立观看' : state.phase === 'reconnecting' ? '网站连接中断，正在重连' : !heartbeatOnline ? '本地程序未在线 / 等待本地程序' : cacheExpired ? '缓存已过期，等待新采样' : !sample ? '客户端心跳在线，等待采样' : stale ? '样本已过期，等待新采样' : snapshot?.source === 'simulation' ? '正在展示模拟采样' : '实时采样已到达';
  const fresh = state.phase === 'watching' && heartbeatOnline && sample && !stale;
  const set = useBmsRealtimeStore.setState;
  useEffect(() => { controller.current.setPermissionRevokedHandler(onPermissionRevoked); return () => controller.current.setPermissionRevokedHandler(undefined); }, [onPermissionRevoked]);
  useEffect(()=>{if(!embedded)return;if(state.identity)hadEmbeddedIdentity.current=true;else if(hadEmbeddedIdentity.current){hadEmbeddedIdentity.current=false;onUnauthorized?.();}},[embedded,state.identity,onUnauthorized]);
  const loadDevices = async () => {
    let devices;
    try { devices = (await bmsApi.devices()).devices; }
    catch (e) { if (e instanceof BmsApiError && e.status === 401) { set({ identity: null }); await bmsApi.session(); } throw e; }
    const d = devices.find((d) => d.deviceId === useBmsRealtimeStore.getState().deviceId) ?? devices[0];
    set({ devices, deviceId: d?.deviceId ?? '', pack: d?.allowedPacks[0] ?? 1 });
  };
  useEffect(() => {
    let alive = true;
    const previousTitle = document.title; document.title = 'BMS 本地实时监测 · 光伏空调实验平台';
    void (async () => {
      if (embedded) {
        const old = useBmsRealtimeStore.getState();
        const changed = old.deviceId !== (embeddedDevice?.deviceId ?? '') || old.identity?.username !== embeddedIdentity?.username;
        if (changed) old.clearData();
        set({ identity: embeddedIdentity ?? null, devices: embeddedDevice ? [embeddedDevice] : [], deviceId: embeddedDevice?.deviceId ?? '', pack: embeddedDevice?.allowedPacks[0] ?? 1 });
        if (autostart && embeddedDevice && isClientForeground()) void controller.current.start(pageId);
        else if (autostart && embeddedDevice && !isClientForeground()) resumeAfterVisibility.current=true;
        setReady(true);
      } else try { const status = await bmsApi.setupStatus(); if (!alive) return; setSetup(status); if (!status.enabled || !status.initialized) return; const identity = await bmsApi.session(); if (!alive) return; set({ identity }); if (identity) await loadDevices(); }
      catch (e) { if (alive) set({ error: e instanceof Error ? e.message : '服务连接失败' }); }
      finally { if (alive) setReady(true); }
    })();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const hidden = () => {
      if (!isClientForeground()) {
        const phase=useBmsRealtimeStore.getState().phase;
        resumeAfterVisibility.current=phase==='connecting'||phase==='watching'||phase==='reconnecting';
        if(resumeAfterVisibility.current)controller.current.stop('paused');
      } else if (resumeAfterVisibility.current) {
        resumeAfterVisibility.current=false;
        void controller.current.start(pageId);
      }
    };
    const unsubscribeForeground = subscribeClientForeground(hidden);
    return () => { alive = false; document.title = previousTitle; clearInterval(timer); unsubscribeForeground(); controller.current.stop(); if (!embedded) useBmsRealtimeStore.getState().reset(); };
  }, [embedded, embeddedDevice?.deviceId, embeddedIdentity?.username, autostart, pageId]);
  const login = async (form: HTMLFormElement) => {
    const data = new FormData(form); setBusy(true); set({ error: '' });
    try { const identity = await bmsApi.login(String(data.get('username')), String(data.get('password'))); set({ identity }); form.reset(); await loadDevices(); }
    catch (e) { set({ error: e instanceof Error ? e.message : '登录失败' }); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    controller.current.stop(); setBusy(true);
    try { await bmsApi.logout(); useBmsRealtimeStore.getState().reset(); await bmsApi.session(); }
    catch (e) { if (e instanceof BmsApiError && e.status === 401) { useBmsRealtimeStore.getState().reset(); void bmsApi.session().catch(() => set({ error: '实时服务暂不可用，请稍后重试' })); } else set({ error: e instanceof Error ? e.message : '登出失败' }); }
    finally { setBusy(false); }
  };
  const selectDevice = (id: string) => { controller.current.stop(); useBmsRealtimeStore.getState().clearData(); const d = state.devices.find((d) => d.deviceId === id); set({ deviceId: id, pack: d?.allowedPacks[0] ?? 1, error: '' }); };
  const metrics = [
    ['总电压', bmsNumber(snapshot?.voltageCentivolts, 100), 'V'], ['电流（保留正负）', bmsNumber(snapshot?.currentCentiamps, 100), 'A'],
    ['SOC', bmsNumber(snapshot?.socPercent, 1, 0), '%'], ['SOH', bmsNumber(snapshot?.sohPercent, 1, 0), '%'],
    ['剩余容量', bmsNumber(snapshot?.remainingCentiAh, 100), 'Ah'], ['总容量', bmsNumber(snapshot?.totalCentiAh, 100), 'Ah'], ['循环次数', bmsNumber(snapshot?.cycles, 1, 0), '次'],
  ];
  const channelPoints = (metric: 'voltage' | 'current' | 'soc') => (state.trends[state.pack]?.[metric] ?? []).filter((p) => `${p.address}/${state.pack}` === state.channel && Date.parse(p.capturedUtc) > now - 3600000);

  return <main className={`bms-page${embedded?' bms-page-embedded':''}`}>
    {!embedded&&<header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>BMS 本地实时监测</h1><DeploymentVersion /></div><nav aria-label="页面导航"><Link to="/monitoring">本地监控</Link><Link to="/experiment/realtime">实验监控</Link><Link to="/bms/manage">设备注册与接入</Link><Link to="/">原理图</Link><Link to="/analysis">数据分析</Link>{state.identity && <><span>{state.identity.username}</span><button disabled={busy} onClick={() => void logout()}>退出观看登录</button></>}</nav></header>}
    <div className="bms-content">
      <div className="bms-intro"><div><h2>{embedded?activeDevice?.alias??'BMS 电池监测':'连接实验室，查看当前采样'}</h2><p>本地程序负责采集和记录。这里查看实时值与一小时趋势；时间使用本地时区。</p></div><span className="bms-readonly">只读监测</span></div>
      {embedded&&!activeDevice&&<p className="bms-notice">此设备暂不可用，请返回设备列表。</p>}
      {state.error && <div className="bms-error" role="alert">{state.error}<button onClick={() => set({ error: '' })} aria-label="关闭提示">×</button></div>}
      {!ready ? <div className="bms-login">正在检查观看登录…</div> : !embedded && setup && (!setup.enabled || !setup.initialized) ? <section className="bms-login"><h2>{setup.enabled ? '先完成管理员与设备注册' : '实时接入尚未启用'}</h2><p>{setup.enabled ? '站点管理员需先初始化账户、注册本地设备并生成上传令牌，再开始网页观看。' : '站点管理员需配置注册存储与初始化密钥，完成后即可在网页注册设备。'}</p><Link to="/bms/manage">前往设备注册与 Windows 接入指南 →</Link></section> : !embedded && !state.identity ? <section className="bms-login"><h2>观看账户登录</h2><p>使用管理员提供的观看账户。设备上传令牌由本地程序保管。</p><p><Link to="/bms/manage">注册设备、创建观看账户或查看 Windows 配置步骤 →</Link></p><form onSubmit={(e) => { e.preventDefault(); void login(e.currentTarget); }}><label>用户名<input name="username" autoComplete="username" required maxLength={80} /></label><label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label><button className="bms-primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button></form></section> : <>
        <section className="bms-toolbar" aria-label="观看设置">{!embedded&&<label>实验设备<select value={state.deviceId} disabled={state.phase === 'connecting'} onChange={(e) => selectDevice(e.target.value)}>{!state.devices.length && <option value="">暂无授权设备</option>}{state.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.alias} · {d.deviceId}</option>)}</select></label>}<label>Pack<select value={state.pack} onChange={(e) => { controller.current.stop(); resumeAfterVisibility.current=false; useBmsRealtimeStore.getState().clearData(); set({ pack: Number(e.target.value) }); if(isClientForeground()&&embedded&&autostart) void controller.current.start(pageId); }}>{(device?.allowedPacks ?? [1]).map((p) => <option key={p} value={p}>Pack {p}</option>)}</select></label><div className="bms-toolbar-actions">{watching ? <button onClick={() => {resumeAfterVisibility.current=false;controller.current.stop();}}>暂停此来源</button> : <button className="bms-primary" disabled={!state.deviceId} onClick={() => void controller.current.start(pageId)}>连接本地数据源</button>}{!embedded&&<button disabled={watching || busy} onClick={() => void loadDevices().catch((e: Error) => set({ error: e.message }))}>刷新设备</button>}</div></section>
        <section className={`bms-status ${fresh ? 'is-fresh' : ''}`} aria-live="polite"><div className="bms-status-title"><span className="bms-dot" /><strong>{status}</strong>{includesSimulation && <span className="bms-simulation">包含模拟数据</span>}</div><p>开始上传通常等待本地下一次心跳，约15秒内加网络耗时。心跳在线不代表串口已连接或正在采集。</p><div className="bms-status-grid"><div><span>网站数据连接</span><b>{state.websiteConnected ? '已连通' : watching ? '正在连接' : '未观看'}</b></div><div><span>客户端心跳</span><b>{heartbeatOnline ? '在线' : '未在线'}</b><small>{bmsTime(device?.lastHeartbeatAt)}</small></div><div><span>观看租约</span><b>{state.lease ? '已建立' : '未建立'}</b><small>{state.lease ? `有效至 ${bmsTime(state.lease.expiresAt)}` : '连接后才请求上传'}</small></div><div><span>最后采样时间</span><b>{bmsTime(snapshot?.capturedUtc)}</b><small>{sample ? `已接收 ${Math.max(0, Math.floor((now - Date.parse(sample.receivedAt)) / 1000))} 秒 · ${snapshot?.periodSeconds ? `采集间隔 ${snapshot.periodSeconds} 秒` : '采集间隔未知'}` : '尚未收到采样'}</small></div></div></section>
        {sample && clockSkew(sample) && <p className="bms-warning" role="status">采样时间与接收时间相差超过1分钟，可能来自时钟偏差、上传延迟或历史缓存回传；页面保留设备原始采样时间。</p>}
        {snapshot && [snapshot.socPercent, snapshot.sohPercent, snapshot.humidityPercent].some((v) => v < 0 || v > 100) && <p className="bms-warning">收到超出0–100%的协议值，已保留原值，请核对仪器。</p>}
        {currentSamples.length > 1 && <label className="bms-channel">测量通道<select value={state.channel} onChange={(e) => set({ channel: e.target.value })}>{currentSamples.map((s) => <option key={bmsChannelKey(s.snapshot)} value={bmsChannelKey(s.snapshot)}>{s.snapshot.source === 'serial' ? '串口采样' : '模拟采样'} · 地址{s.snapshot.address}</option>)}</select></label>}
        <p className="bms-channel">当前通道来源：{sourceLabel(snapshot?.source)}</p>
        {stale && <p className="bms-warning">以下为旧数据／最后观测值，非当前新鲜读数。观测时间：{bmsTime(snapshot?.capturedUtc)}</p>}
        <section className={`bms-metrics ${stale || !fresh ? 'is-muted' : ''}`} aria-label="BMS指标">{metrics.map(([label, value, unit]) => <article key={label}><h3>{label}</h3><div><strong>{value}</strong><span>{unit}</span></div></article>)}</section>
        <section className="bms-trends" aria-label="短趋势"><BmsTrendChart title="总电压" unit="V" color="#2563eb" points={channelPoints('voltage')} /><BmsTrendChart title="电流" unit="A" color="#0891b2" points={channelPoints('current')} /><BmsTrendChart title="SOC" unit="%" color="#059669" points={channelPoints('soc')} /></section>
        <div className="bms-details-grid"><details className="bms-details"><summary>电芯电压 <span>{snapshot?.cellsMillivolts.length ?? 0} 个测点</span></summary><div className="bms-readings">{snapshot?.cellsMillivolts.map((v, i) => <div key={i}><span>电芯 {i + 1}</span><b>{v} <small>mV</small></b></div>) ?? <p>尚未收到电芯读数</p>}</div></details><details className="bms-details"><summary>温度测点 <span>{snapshot?.temperaturesCelsius.length ?? 0} 个测点</span></summary><div className="bms-readings">{snapshot?.temperaturesCelsius.map((v, i) => <div key={i}><span>温度 {i + 1}</span><b>{v} <small>℃</small></b></div>) ?? <p>尚未收到温度读数</p>}</div><p>测点名称尚未确认，按原始编号展示。湿度原始值：{bmsNumber(snapshot?.humidityPercent, 1, 0)}%；0可能表示传感器未接入。</p></details></div>
        <section className="bms-alarm"><h2>告警观测</h2>{snapshot?.alarmObservationAvailable && snapshot.alarmObservation ? <><p>原始告警已观测 / 尚未解码 · 观测时间 {bmsTime(snapshot.alarmObservation.observedUtc)} · 轮次 {snapshot.alarmObservation.acquisitionRound} {stale || now - Date.parse(snapshot.alarmObservation.observedUtc) > Math.max(15000, (snapshot.periodSeconds ?? 15) * 3000) ? '· 历史观测' : ''}</p><code>{snapshot.alarmObservation.payloadHex}</code></> : <p>告警状态未知：尚未收到告警观测。</p>}</section>
        <footer className="bms-footer"><span>云端保留最近1小时观测，本地采集和完整记录由实验程序负责。</span>{state.capacityWarning&&<span className="bms-warning">缓存容量不足，部分新观测已被拒绝；已有历史仍保留，请管理员检查容量。</span>}{state.identity?.role === 'admin' && state.deviceId && <div>{clearing ? <><span>清理当前设备的短缓存？</span><button onClick={async () => { try { await bmsApi.clear(state.deviceId); useBmsRealtimeStore.getState().clearData(); setClearing(false); } catch (e) { set({ error: (e as Error).message }); } }}>确认清理</button><button onClick={() => setClearing(false)}>取消</button></>:<button onClick={() => setClearing(true)}>清理设备短缓存</button>}</div>}</footer>
      </>}
    </div>
  </main>;
}
