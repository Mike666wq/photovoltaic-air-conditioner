import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bmsApi, BmsApiError, monitoringApi } from '../services/bmsRealtimeApi';
import { bmsTime } from '../services/bmsRealtimeTypes';
import { sampleExpired, sampleStale } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsDeviceCredential, BmsIdentity, BmsRegistry, BmsSetupStatus, MonitoringSystemConfig, MonitoringSystemView } from '../services/bmsRealtimeTypes';
import { connectionInstructions, registrationNumbers } from '../services/bmsRegistration';
import { BmsConnectionGuide } from '../components/bmsRealtime/BmsConnectionGuide';
import {ExperimentConnectionGuide} from '../components/bmsRealtime/ExperimentConnectionGuide';
import {EXPERIMENT_EQUIPMENT} from '../services/experimentRealtimeTypes';
import { pointStatus } from '../services/experimentRealtimeTypes';
import { experimentApi } from '../services/experimentRealtimeApi';
import './bms-realtime.css';
import './bms-manage.css';

interface ConnectionSourceCheck {
  module: 'bms' | 'experiment';
  deviceId: string;
  alias: string;
  online: boolean;
  lastHeartbeatAt: string | null;
  freshSamples: number;
  staleSamples: number;
  hadSerialData: boolean;
  freshDescription: string;
  newestSampleAt: string | null;
}

export function BmsManagePage() {
  const [setup, setSetup] = useState<BmsSetupStatus | null>(null);
  const [identity, setIdentity] = useState<BmsIdentity | null>(null);
  const [registry, setRegistry] = useState<BmsRegistry | null>(null);
  const [devices, setDevices] = useState<BmsDevice[]>([]);
  const [systemConfig, setSystemConfig] = useState<MonitoringSystemConfig | null>(null);
  const [systemWritable, setSystemWritable] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState<{ checkedAt: string; sources: ConnectionSourceCheck[] } | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [configDownloaded, setConfigDownloaded] = useState(false);
  const [guideDevice, setGuideDevice] = useState('');
  const [credential, setCredential] = useState<BmsDeviceCredential | null>(null);
  const [reveal, setReveal] = useState(false);
  const [rotating, setRotating] = useState('');
  const [deleting, setDeleting] = useState('');
  const [registrationModule,setRegistrationModule]=useState<'bms'|'experiment'>('bms');
  const [editingUser,setEditingUser]=useState('');
  const [resettingUser,setResettingUser]=useState('');
  const [pendingSystemConfig,setPendingSystemConfig]=useState<{ next: MonitoringSystemConfig; affected: string[] } | null>(null);
  const [pendingPasswordReset,setPendingPasswordReset]=useState<{ username: string; password: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const serviceRoot = setup?.serviceRoot ?? window.location.origin;
  const locked = busy || !!credential || !!pendingSystemConfig || !!pendingPasswordReset || !!deleting || !!rotating;
  const reload = async (user: BmsIdentity) => {
    setSetup(await bmsApi.setupStatus());
    if (user.role === 'admin') {
      const [r, configured] = await Promise.all([bmsApi.registry(), bmsApi.getSystem()]);
      setRegistry(r); setDevices(r.devices); setSystemConfig(configured.system); setSystemWritable(configured.writable);
    }
    else setDevices((await bmsApi.devices()).devices);
  };
  useEffect(() => {
    let alive = true; const title = document.title; document.title = '管理与接入';
    void (async () => {
      try {
        const status = await bmsApi.setupStatus(); if (!alive) return; setSetup(status);
        if (status.enabled) {
          const user = await bmsApi.session(); if (!alive) return; setIdentity(user);
          if (user) {
            if (user.role === 'admin') { const [r, configured] = await Promise.all([bmsApi.registry(), bmsApi.getSystem()]); if (alive) { setRegistry(r); setDevices(r.devices); setSystemConfig(configured.system); setSystemWritable(configured.writable); } }
            else { const r = await bmsApi.devices(); if (alive) setDevices(r.devices); }
          }
        }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; document.title = title; };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) {
      if (e instanceof BmsApiError && e.status === 401) { setIdentity(null); setRegistry(null); setDevices([]); setCredential(null); setPendingSystemConfig(null); setPendingPasswordReset(null); await bmsApi.session().catch(() => {}); }
      setError((e as Error).message);
    }
    finally { setBusy(false); }
  };
  const signIn = (form: HTMLFormElement, first = false) => perform(async () => {
    const b = new FormData(form), username = String(b.get('username')), password = String(b.get('password'));
    if (first && password !== b.get('confirmPassword')) throw new Error('两次密码不一致');
    const user = first ? await bmsApi.bootstrap(username, password, String(b.get('bootstrapToken'))) : await bmsApi.login(username, password);
    setIdentity(user); form.reset(); await reload(user);
    if (first) setNotice('管理员初始化完成。下一步注册本地设备，再创建观看账户。');
  });
  const registerDevice = (form: HTMLFormElement) => perform(async () => {
    const b = new FormData(form);
    const created = await bmsApi.registerDevice({ deviceId: String(b.get('deviceId')).trim(), alias: String(b.get('alias')).trim(), module:registrationModule, ...(registrationModule==='bms'?{allowedAddresses:registrationNumbers(String(b.get('addresses')),255),allowedPacks:registrationNumbers(String(b.get('packs')),16)}:{allowedEquipment:b.getAll('equipment').map(String)}), allowSimulation: b.get('simulation') === 'on' });
    setCredential(created); setReveal(false); setConfigDownloaded(false); setConnectionCheck(null); setGuideDevice(created.device.deviceId); form.reset(); if (identity) await reload(identity);
  });
  const registerUser = (form: HTMLFormElement) => perform(async () => {
    const b = new FormData(form), password = String(b.get('password'));
    if (password !== b.get('confirmPassword')) throw new Error('两次密码不一致');
    const devices = b.getAll('devices').map(String), monitoringAccess = b.get('monitoringAccess') === 'on';
    if (!devices.length && !monitoringAccess) throw new Error('至少选择一台设备或授予“本地监控”权限');
    await bmsApi.registerUser(String(b.get('username')), password, { devices, monitoringAccess });
    form.reset(); if (identity) await reload(identity); setNotice('账户已创建。请通过安全渠道交付初始密码。');
  });
  const download = () => {
    if (!credential) return;
    const url = URL.createObjectURL(new Blob([connectionInstructions(credential, serviceRoot)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${credential.device.module==='experiment'?'experiment':'bms'}-connection-${credential.device.deviceId}.txt`; a.click();
    setConfigDownloaded(true); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const saveSystem = (form: HTMLFormElement) => perform(async () => {
    if (!systemConfig) return;
    const b = new FormData(form);
    const next: MonitoringSystemConfig = {
      name: String(b.get('name')).trim(),
      experimentDeviceId: String(b.get('experimentDeviceId') || '') || null,
      bmsDeviceId: String(b.get('bmsDeviceId') || '') || null,
      allowSimulation: b.get('allowSimulation') === 'on',
    };
    const changedIds = [
      ...(next.experimentDeviceId !== systemConfig.experimentDeviceId ? [systemConfig.experimentDeviceId, next.experimentDeviceId] : []),
      ...(next.bmsDeviceId !== systemConfig.bmsDeviceId ? [systemConfig.bmsDeviceId, next.bmsDeviceId] : []),
    ].filter((id): id is string => !!id);
    const affected = [...new Set(changedIds.map((id) => devices.find((d) => d.deviceId === id)?.alias ?? id))];
    if (affected.length) {
      setPendingSystemConfig({ next, affected });
      return;
    }
    const result = await bmsApi.setSystem(next);
    setSystemConfig(result.system); setConnectionCheck(null);
    setNotice('本地监控系统设置已保存。');
  });
  const confirmSystemChange = () => {
    const pending = pendingSystemConfig;
    if (!pending) return;
    void perform(async () => {
      const result = await bmsApi.setSystem(pending.next);
      setSystemConfig(result.system); setConnectionCheck(null); setPendingSystemConfig(null);
      setNotice('本地监控系统设置已保存；旧、新绑定设备的观看已结束，云端短期历史已清理。');
    });
  };
  const confirmPasswordReset = () => {
    const pending = pendingPasswordReset;
    if (!pending) return;
    void perform(async () => {
      await bmsApi.resetUserPassword(pending.username, pending.password);
      setPendingPasswordReset(null);
      if (identity) await reload(identity);
      setNotice(`账户 ${pending.username} 的密码已重置。请通过安全渠道通知用户。`);
    });
  };
  const checkConnection = async () => {
    setCheckingConnection(true); setError(''); setNotice('');
    try {
      const view: MonitoringSystemView = await monitoringApi.system();
      const sources: ConnectionSourceCheck[] = [];
      if (view.bmsDevice) {
        const device = view.bmsDevice;
        const replies = await Promise.all(device.allowedPacks.map((pack) => bmsApi.latest(device.deviceId, pack)));
        const samples = replies.flatMap((reply) => reply.packs);
        const serial = samples.filter((item) => item.snapshot.source === 'serial');
        const fresh = serial.filter((item) => !sampleStale(item) && !sampleExpired(item) && Date.now() - Date.parse(item.receivedAt) <= 60_000);
        sources.push({ module: 'bms', deviceId: device.deviceId, alias: device.alias, online: device.online, lastHeartbeatAt: device.lastHeartbeatAt, freshSamples: fresh.length, staleSamples: serial.length - fresh.length, hadSerialData: serial.length > 0, freshDescription: `新鲜串口数据包：${fresh.length}`, newestSampleAt: serial.map((item) => item.receivedAt).sort().reverse()[0] ?? null });
      }
      if (view.experimentDevice) {
        const device = view.experimentDevice, latest = await experimentApi.latest(device.deviceId);
        const serial = latest.snapshots.flatMap((sample) => sample.snapshot.source === 'serial' ? sample.snapshot.points : []);
        const fresh = serial.filter((point) => pointStatus(point).good && point.ageMs < 30_000);
        sources.push({ module: 'experiment', deviceId: device.deviceId, alias: device.alias, online: device.online, lastHeartbeatAt: device.lastHeartbeatAt, freshSamples: fresh.length, staleSamples: serial.length - fresh.length, hadSerialData: serial.length > 0, freshDescription: `新鲜串口实测点：${fresh.length}`, newestSampleAt: serial.map((point) => point.observedUtc).sort().reverse()[0] ?? null });
      }
      setConnectionCheck({ checkedAt: new Date().toISOString(), sources });
      if (sources.some((source) => source.freshSamples > 0)) setNotice('已收到新鲜的串口实测数据。心跳状态和测点状态分别显示。');
      else setNotice('当前只读取服务端状态，不会创建观看租约或触发上传。若需验证采集，请在“本地监控”页面开始观看，保持观看连接后再返回读取；停止观看后数据可能转为旧数据。心跳在线不代表测点已到达。');
    } catch (e) { setError((e as Error).message); }
    finally { setCheckingConnection(false); }
  };
  return <main className="bms-page bms-management">
    <header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>管理与接入</h1></div><nav aria-label="页面导航"><Link to="/monitoring">本地监控</Link><Link to="/experiment/realtime">实验监控</Link><Link to="/bms/realtime">BMS 实时监测</Link><Link to="/">原理图</Link>{identity && <><span>{identity.username} · {identity.role === 'admin' ? '管理员' : '观看账户'}</span><button disabled={locked} onClick={() => void perform(async () => { await bmsApi.logout(); setIdentity(null); setRegistry(null); setDevices([]); setCredential(null); setSystemConfig(null); setConfigDownloaded(false); setConnectionCheck(null); await bmsApi.session(); })}>退出登录</button></>}</nav></header>
    <div className="bms-content">
      <div className="bms-onboarding-steps" aria-label="四步接入向导"><span className={devices.length ? 'is-complete' : ''}>① 注册设备</span><span className={systemConfig && (systemConfig.bmsDeviceId || systemConfig.experimentDeviceId) ? 'is-complete' : ''}>② 绑定可用设备</span><span className={configDownloaded ? 'is-complete' : ''}>③ 下载 Windows 手动配置说明</span><span className={connectionCheck?.sources.some((source) => source.freshSamples > 0) ? 'is-complete' : ''}>④ 验证心跳与真实测点</span></div>
      {error && <p className="bms-error" role="alert">{error}</p>}{notice && <p className="bms-notice" role="status">{notice}</p>}
      {!ready ? <p>正在读取注册状态…</p> : !setup?.enabled ? <section className="bms-admin-card"><h2>站点尚未启用实时接入</h2><p>站点管理员需要先配置注册存储和初始化密钥。完成后，这里会显示管理员初始化表单，再通过网页注册设备和观看账户。</p><p>实验人员可以先按下面的步骤确认 Windows 本地采集正常。</p></section> : !setup.initialized ? <section className="bms-admin-card bms-first-admin"><h2>首次初始化管理员</h2><p>由站点持有者使用服务器提供的初始化密钥创建首个管理员。初始化只允许完成一次；随后设备和观看账户均从这里管理。</p>{!setup.bootstrapAvailable ? <p className="bms-warning">初始化密钥或持久化注册存储尚未配置，请联系站点管理员。</p> : <form onSubmit={(e) => { e.preventDefault(); void signIn(e.currentTarget, true); }}><label>初始化密钥<input name="bootstrapToken" type="password" required autoComplete="off" minLength={32} maxLength={256} disabled={busy} /></label><label>管理员用户名<input name="username" required autoComplete="username" pattern="[a-zA-Z0-9_.-]{3,80}" minLength={3} maxLength={80} disabled={busy} /></label><label>管理员密码<input name="password" type="password" required autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} /></label><label>确认管理员密码<input name="confirmPassword" type="password" required autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} /></label><button className="bms-primary" disabled={busy}>{busy ? '正在初始化…' : '创建首个管理员'}</button></form>}</section> : !identity ? <section className="bms-login"><h2>登录设备管理</h2><p>管理员登录后可注册设备、创建观看账户和轮换令牌。观看账户可登录查看自己的接入说明；新观看账户由管理员创建。</p><form onSubmit={(e) => { e.preventDefault(); void signIn(e.currentTarget); }}><label>用户名<input name="username" autoComplete="username" required maxLength={80} disabled={busy} /></label><label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={busy} /></label><button className="bms-primary" disabled={busy}>登录</button></form></section> : identity.role !== 'admin' ? <p className="bms-notice">你当前使用观看账户。设备注册和新账户创建由管理员完成，下面展示你获准设备的本地接入说明。</p> : <>
        {!registry?.writable && <p className="bms-warning">当前部署使用只读注册配置。请运维启用持久化注册存储后再新增设备、账户或轮换令牌。</p>}
        {systemConfig && <section className="bms-admin-card bms-system-settings"><h2>本地监控系统设置</h2><p>一套装置最多绑定一个实验采集源和一个 BMS 设备，两者可单独留空。绑定设备可由管理员及获准整体监控的账户在实时页查看。</p><p className="bms-watch-hint">设备仅在有人观看时获得上传租约。需要验证真实采样时，先在新标签页开始观看，再回到这里读取状态；停止观看后旧点可能显示为过期。</p><p><Link to="/monitoring" target="_blank" rel="noreferrer">在新标签页打开本地监控并开始观看</Link></p><form key={`${systemConfig.name}|${systemConfig.experimentDeviceId ?? ''}|${systemConfig.bmsDeviceId ?? ''}|${systemConfig.allowSimulation}`} onSubmit={(e) => { e.preventDefault(); void saveSystem(e.currentTarget); }}>
          <label>系统名称<input name="name" required maxLength={128} defaultValue={systemConfig.name} disabled={locked || !systemWritable} /></label>
          <label>实验采集源<select name="experimentDeviceId" defaultValue={systemConfig.experimentDeviceId ?? ''} disabled={locked || !systemWritable}><option value="">暂不绑定</option>{devices.filter((d) => d.module === 'experiment').map((d) => <option value={d.deviceId} key={d.deviceId}>{d.alias} · {d.deviceId}</option>)}</select></label>
          <label>BMS 设备<select name="bmsDeviceId" defaultValue={systemConfig.bmsDeviceId ?? ''} disabled={locked || !systemWritable}><option value="">暂不绑定</option>{devices.filter((d) => d.module !== 'experiment').map((d) => <option value={d.deviceId} key={d.deviceId}>{d.alias} · {d.deviceId}</option>)}</select></label>
          <label className="bms-checkbox"><input name="allowSimulation" type="checkbox" defaultChecked={systemConfig.allowSimulation} disabled={locked || !systemWritable} />允许本地监控系统接收模拟数据（仍须设备自身也获准）</label>
          <div className="bms-admin-actions"><button className="bms-primary" disabled={locked || !systemWritable}>保存系统设置</button><button type="button" disabled={locked || checkingConnection} onClick={() => void checkConnection()}>{checkingConnection ? '正在读取服务端状态…' : '读取绑定设备状态与真实测点'}</button></div>
        </form>
        {pendingSystemConfig && <div className="bms-inline-confirm" role="alert"><strong>确认系统绑定变更</strong><p>保存后会结束相关设备的观看，并清理旧、新绑定设备的云端短期历史：{pendingSystemConfig.affected.join('、')}。其他模块的观看保持不变。</p><div className="bms-admin-actions"><button className="bms-primary" disabled={busy} onClick={confirmSystemChange}>确认并保存绑定</button><button disabled={busy} onClick={() => setPendingSystemConfig(null)}>取消</button></div></div>}
        {connectionCheck && <div className="bms-connection-status" role="status"><p>服务端状态读取时间：{bmsTime(connectionCheck.checkedAt)}。只读请求没有创建观看租约，也不会触发客户端上传。</p>{!connectionCheck.sources.length ? <p>当前没有绑定设备。</p> : connectionCheck.sources.map((source) => <article key={`${source.module}/${source.deviceId}`}><strong>{source.module === 'bms' ? 'BMS' : '实验源'} · {source.alias}</strong><span>{source.online ? '客户端心跳在线' : '客户端心跳离线'}</span><span>最后心跳：{bmsTime(source.lastHeartbeatAt)}</span><span>{source.freshSamples ? `${source.freshDescription} · 最近采样 ${bmsTime(source.newestSampleAt)}` : source.hadSerialData ? `有串口数据，但已过期或质量无效（最近 ${bmsTime(source.newestSampleAt)}）` : '尚未收到串口实测数据'}</span></article>)}</div>}
        </section>}
        {credential && <section className="bms-credential" aria-label="新设备接入凭据"><h2>保存设备上传令牌与本地配置</h2><p>设备：{credential.device.alias} · {credential.device.deviceId}。令牌仅在注册或轮换成功后显示一次，关闭后云端只保留散列。</p><label>设备上传令牌（仅显示一次）<input type={reveal ? 'text' : 'password'} value={credential.deviceToken} readOnly autoComplete="off" /></label><div className="bms-admin-actions"><button onClick={() => setReveal(!reveal)}>{reveal ? '隐藏令牌' : '显示令牌'}</button><button onClick={() => void navigator.clipboard.writeText(credential.deviceToken).then(() => setNotice('令牌已复制，请只填入本地客户端')).catch(() => setError('复制失败，请显示令牌后手动复制'))}>复制令牌</button><button className="bms-primary" onClick={download}>下载 Windows 配置说明（含令牌）</button><button onClick={() => { setCredential(null); setReveal(false); }}>已保存，关闭凭据</button></div><p>配置文件含私密上传令牌，请保存在 Windows 用户的安全目录，不要发到聊天、公开链接或仓库。</p></section>}
        <div className="bms-admin-forms"><section className="bms-admin-card"><h2>注册本地设备</h2><p>BMS 与实验采集源分别注册；设备编号复制自对应 Windows 客户端。</p><form onSubmit={(e) => { e.preventDefault(); void registerDevice(e.currentTarget); }}><label>采集模块<select value={registrationModule} disabled={locked} onChange={e=>setRegistrationModule(e.target.value as 'bms'|'experiment')}><option value="bms">BMS 电池监控</option><option value="experiment">实验监控（37测点）</option></select></label><label>设备编号 deviceId<input name="deviceId" required pattern="[a-zA-Z0-9_-]{1,80}" maxLength={80} placeholder="复制Windows客户端中的deviceId" disabled={locked || !registry?.writable} /></label><label>设备名称<input name="alias" required maxLength={128} placeholder="例如：实验室1号电池" disabled={locked || !registry?.writable} /></label>{registrationModule==='bms'?<><label>BMS 地址（逗号分隔）<input name="addresses" required placeholder="填写实际地址，例如1" disabled={locked || !registry?.writable} /></label><label>Pack 编号（逗号分隔）<input name="packs" required placeholder="填写实际Pack，例如1,2" disabled={locked || !registry?.writable} /></label></>:<fieldset disabled={locked || !registry?.writable}><legend>授权实验仪器</legend>{EXPERIMENT_EQUIPMENT.map(id=><label className="bms-checkbox" key={id}><input type="checkbox" name="equipment" value={id} defaultChecked/>{id}</label>)}</fieldset>}<label className="bms-checkbox"><input name="simulation" type="checkbox" disabled={locked || !registry?.writable} />允许该设备上传模拟数据（实验验证时才开启）</label><button className="bms-primary" disabled={locked || !registry?.writable}>注册设备并生成上传令牌</button></form></section>
        <section className="bms-admin-card"><h2>创建账户</h2><p>可按需授权具体设备、整体“本地监控”页面，或同时授权。整体权限只能查看已绑定设备，不提供设备管理功能。</p><form onSubmit={(e) => { e.preventDefault(); void registerUser(e.currentTarget); }}><label>用户名<input name="username" required pattern="[a-zA-Z0-9_.-]{3,80}" minLength={3} maxLength={80} autoComplete="off" disabled={locked || !registry?.writable} /></label><label>初始密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked || !registry?.writable} /></label><label>确认初始密码<input name="confirmPassword" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked || !registry?.writable} /></label><label className="bms-checkbox"><input name="monitoringAccess" type="checkbox" disabled={locked || !registry?.writable} />允许查看整体“本地监控”系统（绑定设备）</label><fieldset disabled={locked || !registry?.writable}><legend>授权设备（可不选）</legend>{!devices.length ? <p>目前没有设备。</p> : devices.map((d) => <label className="bms-checkbox" key={d.deviceId}><input type="checkbox" name="devices" value={d.deviceId} />{d.alias} · {d.deviceId}</label>)}</fieldset><button className="bms-primary" disabled={locked || !registry?.writable}>创建账户</button></form></section></div>
        <section className="bms-admin-card"><h2>已注册设备</h2>{!devices.length ? <p>还没有设备，请先完成上面的设备注册。</p> : <div className="bms-device-list">{devices.map((d) => <article key={d.deviceId}><h3>{d.alias}</h3><code>{d.deviceId}</code><p>{d.module==='experiment'?`实验监控 · 仪器：${d.allowedEquipment?.join('、')}`:`BMS · 地址：${d.allowedAddresses?.join('、')} · Pack：${d.allowedPacks.join('、')}`}</p><p>{d.allowSimulation ? '允许模拟数据' : '仅接收串口实测'} · {d.online ? '客户端心跳在线' : '客户端未在线'}</p><small>最后心跳：{bmsTime(d.lastHeartbeatAt)}</small><div className="bms-admin-actions"><button disabled={locked} onClick={() => setGuideDevice(d.deviceId)}>查看本地配置步骤</button>{rotating === d.deviceId ? <><span>旧令牌将立即失效，当前观看也将结束。</span><button disabled={busy} onClick={() => void perform(async () => { const c = await bmsApi.rotateDevice(d.deviceId); setCredential(c); setReveal(false); setConfigDownloaded(false); setGuideDevice(d.deviceId); if (identity) await reload(identity); })}>确认轮换</button><button disabled={busy} onClick={() => setRotating('')}>取消</button></> : <button disabled={locked || !registry?.writable} onClick={() => { setDeleting(''); setRotating(d.deviceId); }}>轮换上传令牌</button>}{deleting === d.deviceId ? <><span>删除会撤销此设备令牌、结束观看、清除此设备缓存，并移除各账户对这台设备的逐设备授权。整体“本地监控”授权保留；若此设备是系统绑定源，获准用户仍可查看其他绑定源。本地记录保留。</span><button disabled={busy} onClick={() => void perform(async () => { await bmsApi.deleteDevice(d.deviceId); setDeleting(''); setGuideDevice((id) => id === d.deviceId ? '' : id); setConnectionCheck(null); if (identity) await reload(identity); setNotice('设备已删除；此设备的逐设备授权与云端缓存已移除，本地记录保留。'); })}>确认删除设备</button><button disabled={busy} onClick={() => setDeleting('')}>取消删除</button></> : <button disabled={locked || !registry?.writable} onClick={() => { setRotating(''); setDeleting(d.deviceId); }}>删除设备</button>}</div></article>)}</div>}</section>
        <section className="bms-admin-card"><h2>账户权限与状态</h2><ul className="bms-user-list">{registry?.users.map((u) => <li key={u.username}><strong>{u.username}</strong><span>{u.role === 'admin' ? '管理员' : '观看账户'}</span><span>{u.monitoringAccess || u.role === 'admin' ? '可查看本地监控' : '无整体监控权限'}</span><span>{u.disabled ? '已停用' : '正常'}</span><span>设备：{u.devices.join('、') || '未授权设备'}</span>{u.role==='viewer'&&<button disabled={locked||!registry?.writable} onClick={()=>{setEditingUser(u.username);setResettingUser('');}}>修改授权与状态</button>}{u.username !== identity?.username && <button disabled={locked || !registry?.writable} onClick={() => { setResettingUser(u.username); setEditingUser(''); }}>重置密码</button>}</li>)}</ul>
          {editingUser && (() => { const target = registry?.users.find((u) => u.username === editingUser); if (!target) return null; return <form key={editingUser} className="bms-user-edit" onSubmit={(e) => {
            e.preventDefault(); const form = e.currentTarget, data = new FormData(form), devicesNext = data.getAll('devices').map(String);
            void perform(async () => {
              await bmsApi.updateUserDevices(editingUser, devicesNext);
              try {
                await bmsApi.updateUser(editingUser, { monitoringAccess: data.get('monitoringAccess') === 'on', disabled: data.get('disabled') === 'on' });
              } catch (cause) {
                const refreshed = identity ? await reload(identity).then(() => true).catch(() => false) : false;
                setEditingUser('');
                setNotice(refreshed ? '设备授权已保存；整体监控权限或账户状态未确认保存，当前页面已按服务端状态刷新。' : '设备授权已保存；整体监控权限或账户状态未确认保存，且未能刷新当前服务端状态，请重新载入此页核对。');
                throw new Error(`整体监控权限或账户状态更新失败：${(cause as Error).message}`);
              }
              setEditingUser(''); if (identity) await reload(identity); setNotice('账户授权与状态已更新；失去权限的观看会话已撤销。');
            });
          }}><h3>修改 {editingUser} 的授权与状态</h3><fieldset disabled={locked}><legend>允许观看的独立设备</legend>{devices.map((d)=><label className="bms-checkbox" key={d.deviceId}><input type="checkbox" name="devices" value={d.deviceId} defaultChecked={target.devices.includes(d.deviceId)}/>{d.alias} · {d.module==='experiment'?'实验监控':'BMS'} · {d.deviceId}</label>)}</fieldset><label className="bms-checkbox"><input type="checkbox" name="monitoringAccess" defaultChecked={!!target.monitoringAccess} disabled={locked}/>允许查看整体“本地监控”（当前系统绑定设备）</label><label className="bms-checkbox"><input type="checkbox" name="disabled" defaultChecked={!!target.disabled} disabled={locked}/>停用该账户并撤销当前登录与观看</label><div className="bms-admin-actions"><button className="bms-primary" disabled={locked}>保存账户设置</button><button type="button" disabled={busy} onClick={()=>setEditingUser('')}>取消</button></div></form>; })()}
          {resettingUser && !pendingPasswordReset && <form key={`reset/${resettingUser}`} className="bms-user-edit" onSubmit={(e) => { e.preventDefault(); const password = String(new FormData(e.currentTarget).get('password')); setPendingPasswordReset({ username: resettingUser, password }); }}><h3>重置 {resettingUser} 的密码</h3><label>新密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked}/></label><div className="bms-admin-actions"><button className="bms-primary" disabled={locked}>继续</button><button type="button" disabled={busy} onClick={()=>setResettingUser('')}>取消</button></div></form>}
          {pendingPasswordReset && <div className="bms-inline-confirm" role="alert"><strong>确认重置密码</strong><p>将为账户 {pendingPasswordReset.username} 设置你输入的新密码。系统不会再次显示；请自行通过安全渠道通知该用户。</p><div className="bms-admin-actions"><button className="bms-primary" disabled={busy} onClick={confirmPasswordReset}>确认重置</button><button disabled={busy} onClick={() => { setPendingPasswordReset(null); setResettingUser(''); }}>取消</button></div></div>}
        </section>
      </>}
      {!!devices.length && <label className="bms-guide-selector">接入指南设备<select disabled={locked} value={guideDevice} onChange={(e) => setGuideDevice(e.target.value)}><option value="">通用接入步骤</option>{devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.alias} · {d.deviceId}</option>)}</select></label>}
      {(devices.find(d=>d.deviceId===guideDevice)?.module??registrationModule)==='experiment'?<ExperimentConnectionGuide serviceRoot={serviceRoot} device={devices.find(d=>d.deviceId===guideDevice)}/>:<BmsConnectionGuide serviceRoot={serviceRoot} device={devices.find((d) => d.deviceId === guideDevice)} />}
    </div>
  </main>;
}
