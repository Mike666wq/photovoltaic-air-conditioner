import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bmsApi, BmsApiError, monitoringApi } from '../services/bmsRealtimeApi';
import type { BmsIdentity, BmsSetupStatus, MonitoringSystemView } from '../services/bmsRealtimeTypes';
import { BmsRealtimePage } from './BmsRealtimePage';
import { ExperimentRealtimePage } from './ExperimentRealtimePage';
import './bms-realtime.css';
import './experiment-realtime.css';

type MonitorMode = 'experiment' | 'bms' | 'both';
function createPageId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function MonitoringPage() {
  const [setup, setSetup] = useState<BmsSetupStatus | null>(null);
  const [identity, setIdentity] = useState<BmsIdentity | null>(null);
  const [system, setSystem] = useState<MonitoringSystemView | null>(null);
  const [systemPermission, setSystemPermission] = useState<'unknown'|'allowed'|'denied'>('unknown');
  const [mode, setMode] = useState<MonitorMode>('both');
  const [pageId, setPageId] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadMonitoring = useCallback(async (user: BmsIdentity | null) => {
    setMode('both');
    setIdentity(user); setSystem(null); setSystemPermission(user?'unknown':'denied');
    if (user) {
      try {
        const dto = await monitoringApi.system();
        setSystem(dto); setSystemPermission('allowed'); setPageId(createPageId());
      } catch (cause) {
        if (cause instanceof BmsApiError && cause.status === 403) { setSystemPermission('denied'); return; }
        throw cause;
      }
    }
  }, []);

  useEffect(() => {
    let alive = true; const previousTitle = document.title; document.title = '本地监控 · 光伏空调实验平台';
    void (async () => {
      try {
        const status = await bmsApi.setupStatus(); if (!alive) return; setSetup(status);
        const user = status.enabled && status.initialized ? await bmsApi.session() : null;
        if (!alive) return;
        setIdentity(user);
        if (user) {
          try { const dto = await monitoringApi.system(); if (!alive) return; setSystem(dto); setSystemPermission('allowed'); setPageId(createPageId()); }
          catch (cause) { if (!alive) return; if (cause instanceof BmsApiError && cause.status === 403) setSystemPermission('denied'); else throw cause; }
        } else setSystemPermission('denied');
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : '监控服务暂不可用'); }
      finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; document.title = previousTitle; };
  }, []);

  const login = async (form: HTMLFormElement) => {
    const data = new FormData(form); setBusy(true); setError('');
    try {
      const user = await bmsApi.login(String(data.get('username')), String(data.get('password')));
      await loadMonitoring(user); form.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError('');
    try { await bmsApi.logout(); setIdentity(null); setSystem(null); setSystemPermission('unknown'); setPageId(''); await bmsApi.session(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出登录失败'); }
    finally { setBusy(false); }
  };

  const isAdmin = identity?.role === 'admin';
  const mayMonitor = systemPermission === 'allowed';
  const onUnauthorized = () => { setIdentity(null); setSystem(null); setSystemPermission('unknown'); setPageId(''); setError('登录已失效，请重新登录。'); };
  const showExperiment = mode === 'both' || mode === 'experiment';
  const showBms = mode === 'both' || mode === 'bms';

  return <main className="bms-page monitoring-page">
    <header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>{system?.name ?? '本地监控'}</h1></div><nav aria-label="页面导航"><Link to="/">原理图</Link><Link to="/analysis">文件数据分析</Link>{isAdmin&&<Link to="/monitoring/manage">设备与账户管理</Link>}{identity&&<><span>{identity.username} · {identity.role==='admin'?'管理员':'观看账户'}</span><button disabled={busy} onClick={()=>void logout()}>退出登录</button></>}</nav></header>
    <div className="bms-content">
      {error&&<p className="bms-error" role="alert">{error}</p>}
      {!ready?<section className="bms-login">正在检查登录状态…</section>:setup&&(!setup.enabled||!setup.initialized)?<section className="bms-login"><h2>{setup.enabled?'实时监控尚未初始化':'实时监控未启用'}</h2><p>请先完成站点管理员初始化和本地采集设备注册。</p><Link to="/monitoring/manage">管理员初始化与设备管理 →</Link></section>:!identity?<section className="bms-login"><h2>统一账户登录</h2><p>使用管理员创建的观看账户。登录后根据账户权限查看已绑定的实验采集源和 BMS。</p><form onSubmit={e=>{e.preventDefault();void login(e.currentTarget);}}><label>用户名<input name="username" autoComplete="username" required maxLength={80}/></label><label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label><button className="bms-primary" disabled={busy}>{busy?'正在登录…':'登录'}</button></form></section>:systemPermission==='denied'?<section className="bms-login"><h2>没有整体监控权限</h2><p>请联系管理员为此账户开启本地监控授权。</p></section>:systemPermission!=='allowed'||!system?<section className="bms-login">正在读取已绑定的监控设备…</section>:<>
        <div className="monitoring-toolbar"><div><h2>实时总览</h2><p>两路采集彼此独立；一路离线或未绑定时，另一路仍可继续显示。</p></div><fieldset aria-label="监控内容"><legend>显示内容</legend><label><input type="radio" name="monitor-mode" value="both" checked={mode==='both'} onChange={()=>setMode('both')}/>两者一起</label><label><input type="radio" name="monitor-mode" value="experiment" checked={mode==='experiment'} onChange={()=>setMode('experiment')}/>实验监控</label><label><input type="radio" name="monitor-mode" value="bms" checked={mode==='bms'} onChange={()=>setMode('bms')}/>BMS</label></fieldset></div>
        {showExperiment&&(system.experimentDevice?<ExperimentRealtimePage embedded identity={identity} device={system.experimentDevice} source="serial" autostart pageId={pageId} onUnauthorized={onUnauthorized}/>:<section className="monitoring-missing"><h2>实验采集源尚未绑定</h2><p>实验监控不可用时，BMS 通道仍可独立查看。</p>{isAdmin&&<Link to="/monitoring/manage">配置绑定设备 →</Link>}</section>)}
        {showBms&&(system.bmsDevice?<BmsRealtimePage embedded identity={identity} device={system.bmsDevice} source="serial" autostart pageId={pageId} onUnauthorized={onUnauthorized}/>:<section className="monitoring-missing"><h2>BMS 尚未绑定</h2><p>BMS 不可用时，实验采集通道仍可独立查看。</p>{isAdmin&&<Link to="/monitoring/manage">配置绑定设备 →</Link>}</section>)}
      </>}
    </div>
  </main>;
}
