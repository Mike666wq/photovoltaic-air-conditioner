import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { bmsApi, BmsApiError, monitoringApi } from '../services/bmsRealtimeApi';
import { bmsTime } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsIdentity } from '../services/bmsRealtimeTypes';
import './bms-realtime.css';
import './experiment-realtime.css';

type ModuleFilter = 'all' | 'bms' | 'experiment';

export function MonitoringPage() {
  const [identity, setIdentity] = useState<BmsIdentity | null>(null);
  const [devices, setDevices] = useState<BmsDevice[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refreshSequence = useRef(0);
  const mounted = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const requestedFilter = searchParams.get('module');
  const filter: ModuleFilter = requestedFilter === 'bms' || requestedFilter === 'experiment' ? requestedFilter : 'all';
  const deviceListView = identity?.role !== 'admin' || searchParams.get('view') === 'devices' || filter !== 'all';
  const routeNotice = (location.state as { notice?: string } | null)?.notice;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setBusy(true);
    setError('');
    try {
      const result = await monitoringApi.devices();
      if (mounted.current && sequence === refreshSequence.current) setDevices(result.devices);
    } catch (cause) {
      if (!mounted.current || sequence !== refreshSequence.current) return;
      if (cause instanceof BmsApiError && cause.status === 401) {
        setIdentity(null);
        setDevices([]);
        setError('登录已失效，请重新登录。');
      } else setError(cause instanceof Error ? cause.message : '设备列表暂不可用');
    } finally { if (mounted.current && sequence === refreshSequence.current) setBusy(false); }
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshSequence.current++; }; }, []);

  useEffect(() => {
    let alive = true;
    const previousTitle = document.title;
    document.title = '实时观测 · 光伏空调实验平台';
    void (async () => {
      try {
        const status = await bmsApi.setupStatus();
        if (!alive) return;
        if (!status.enabled || !status.initialized) {
          setError(status.enabled ? '实时监控尚未初始化，请先创建管理员账户。' : '实时监控尚未启用。');
          return;
        }
        const user = await bmsApi.session();
        if (!alive) return;
        setIdentity(user);
        if (user) setDevices((await monitoringApi.devices()).devices);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : '无法读取登录状态');
      } finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; document.title = previousTitle; };
  }, []);

  useEffect(() => {
    if (!identity || !deviceListView) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
    const start = () => {
      stop();
      if (!document.hidden) {
        void refresh();
        timer = setInterval(() => { void refresh(); }, 5000);
      }
    };
    const onVisibility = () => document.hidden ? stop() : start();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [identity, deviceListView, refresh]);

  const login = async (form: HTMLFormElement) => {
    refreshSequence.current++;
    const data = new FormData(form);
    setBusy(true); setError('');
    try {
      const user = await bmsApi.login(String(data.get('username')), String(data.get('password')));
      setIdentity(user); setDevices((await monitoringApi.devices()).devices); form.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    refreshSequence.current++;
    setBusy(true); setError('');
    try { await bmsApi.logout(); setIdentity(null); setDevices([]); setSearchParams({}, { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出登录失败'); }
    finally { setBusy(false); }
  };

  const visibleDevices = useMemo(() => devices.filter(device => filter === 'all' || (device.module === 'experiment' ? 'experiment' : 'bms') === filter), [devices, filter]);
  const experimentDevices = visibleDevices.filter(device => device.module === 'experiment');
  const bmsDevices = visibleDevices.filter(device => device.module !== 'experiment');
  const setFilter = (next: ModuleFilter) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'all') params.delete('module'); else params.set('module', next);
    params.set('view', 'devices');
    setSearchParams(params, { replace: true });
  };

  return <main className="bms-page monitoring-page">
    <header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>实时观测</h1></div><nav aria-label="页面导航"><Link to="/">原理图</Link><Link to="/analysis">文件数据分析</Link>{identity?.role === 'admin' && <Link to="/monitoring/manage">设备与账户管理</Link>}{identity && <><span>{identity.username} · {identity.role === 'admin' ? '管理员' : '观察者'}</span><button disabled={busy} onClick={() => void logout()}>退出登录</button></>}</nav></header>
    <div className="bms-content">
      {error && <p className="bms-error" role="alert">{error}</p>}
      {routeNotice && <p className="bms-notice" role="status">{routeNotice}</p>}
      {!ready ? <section className="bms-login">正在检查登录状态…</section> : !identity ? <section className="bms-login"><h2>统一账户登录</h2><p>登录后可查看管理员分配给你的设备。</p><form onSubmit={event => { event.preventDefault(); void login(event.currentTarget); }}><label>用户名<input name="username" autoComplete="username" required maxLength={80} /></label><label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label><button className="bms-primary" disabled={busy}>{busy ? '正在登录…' : '登录'}</button></form></section> : identity.role === 'admin' && !deviceListView ? <section className="monitoring-workbench"><div className="monitoring-workbench__intro"><h2>管理员工作台</h2><p>选择管理设备账户，或进入实时观测设备列表。</p></div><div className="monitoring-workbench__actions"><Link className="monitoring-entry" to="/monitoring/manage"><span>管理入口</span><strong>设备与账户管理</strong><small>注册设备、配置接入、分配观察权限</small></Link><Link className="monitoring-entry monitoring-entry--observe" to="/monitoring?view=devices"><span>只读入口</span><strong>实时观测</strong><small>打开设备列表后再选择要观测的设备</small></Link></div></section> : <>
        <section className="monitoring-list-toolbar"><div><h2>{identity.role === 'admin' ? '全部设备' : '我的授权设备'}</h2><p>心跳状态仅表示客户端最近联系情况，不代表新鲜测点已到达。</p></div><div className="monitoring-list-actions"><label>设备类型<select aria-label="设备类型" value={filter} onChange={event => setFilter(event.target.value as ModuleFilter)}><option value="all">全部设备</option><option value="experiment">实验采集</option><option value="bms">BMS</option></select></label><button disabled={busy} onClick={() => void refresh()}>{busy ? '正在刷新…' : '刷新设备'}</button>{identity.role === 'admin' && <button onClick={() => setSearchParams({}, { replace: true })}>返回工作台</button>}</div></section>
        {!devices.length ? <section className="monitoring-empty"><h2>{identity.role === 'admin' ? '暂无已注册设备' : '尚未分配观测设备'}</h2><p>{identity.role === 'admin' ? '请在设备与账户管理中注册设备。' : '请联系管理员为你的账户分配设备权限。'}</p></section> : !visibleDevices.length ? <section className="monitoring-empty"><p>当前类别没有设备。</p></section> : <div className="monitoring-device-groups">
          {experimentDevices.length > 0 && <DeviceGroup title="实验采集" devices={experimentDevices} />}
          {bmsDevices.length > 0 && <DeviceGroup title="BMS" devices={bmsDevices} />}
        </div>}
      </>}
    </div>
  </main>;
}

function DeviceGroup({ title, devices }: { title: string; devices: BmsDevice[] }) {
  return <section className="monitoring-device-group"><h3>{title}</h3><div className="monitoring-device-list">{devices.map(device => <Link className="monitoring-device-card" key={device.deviceId} to={`/monitoring/devices/${encodeURIComponent(device.deviceId)}`}>
    <span className={`monitoring-device-card__dot${device.online ? ' is-online' : ''}`} aria-label={device.online ? '心跳在线' : '心跳离线'} />
    <span className="monitoring-device-card__main"><strong>{device.alias}</strong><code>{device.deviceId}</code></span>
    <span className="monitoring-device-card__status">{device.online ? '心跳在线' : '心跳离线'}<small>最后心跳：{bmsTime(device.lastHeartbeatAt)}</small></span>
    <span className="monitoring-device-card__action">开始观测 →</span>
  </Link>)}</div></section>;
}
