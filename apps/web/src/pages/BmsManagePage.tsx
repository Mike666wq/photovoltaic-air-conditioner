import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bmsApi, BmsApiError } from '../services/bmsRealtimeApi';
import { bmsTime } from '../services/bmsRealtimeTypes';
import type { BmsDevice, BmsDeviceCredential, BmsIdentity, BmsRegistry, BmsSetupStatus } from '../services/bmsRealtimeTypes';
import { connectionInstructions, registrationNumbers } from '../services/bmsRegistration';
import { BmsConnectionGuide } from '../components/bmsRealtime/BmsConnectionGuide';
import './bms-realtime.css';
import './bms-manage.css';

export function BmsManagePage() {
  const [setup, setSetup] = useState<BmsSetupStatus | null>(null);
  const [identity, setIdentity] = useState<BmsIdentity | null>(null);
  const [registry, setRegistry] = useState<BmsRegistry | null>(null);
  const [devices, setDevices] = useState<BmsDevice[]>([]);
  const [guideDevice, setGuideDevice] = useState('');
  const [credential, setCredential] = useState<BmsDeviceCredential | null>(null);
  const [reveal, setReveal] = useState(false);
  const [rotating, setRotating] = useState('');
  const [deleting, setDeleting] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const serviceRoot = setup?.serviceRoot ?? window.location.origin;
  const locked = busy || !!credential;
  const reload = async (user: BmsIdentity) => {
    setSetup(await bmsApi.setupStatus());
    if (user.role === 'admin') { const r = await bmsApi.registry(); setRegistry(r); setDevices(r.devices); }
    else setDevices((await bmsApi.devices()).devices);
  };
  useEffect(() => {
    let alive = true; const title = document.title; document.title = '设备注册与接入 · BMS';
    void (async () => {
      try {
        const status = await bmsApi.setupStatus(); if (!alive) return; setSetup(status);
        if (status.enabled) {
          const user = await bmsApi.session(); if (!alive) return; setIdentity(user);
          if (user) {
            if (user.role === 'admin') { const r = await bmsApi.registry(); if (alive) { setRegistry(r); setDevices(r.devices); } }
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
      if (e instanceof BmsApiError && e.status === 401) { setIdentity(null); setRegistry(null); setDevices([]); setCredential(null); await bmsApi.session().catch(() => {}); }
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
    const created = await bmsApi.registerDevice({ deviceId: String(b.get('deviceId')).trim(), alias: String(b.get('alias')).trim(), allowedAddresses: registrationNumbers(String(b.get('addresses')), 255), allowedPacks: registrationNumbers(String(b.get('packs')), 16), allowSimulation: b.get('simulation') === 'on' });
    setCredential(created); setReveal(false); setGuideDevice(created.device.deviceId); form.reset(); if (identity) await reload(identity);
  });
  const registerUser = (form: HTMLFormElement) => perform(async () => {
    const b = new FormData(form), password = String(b.get('password'));
    if (password !== b.get('confirmPassword')) throw new Error('两次密码不一致');
    await bmsApi.registerUser(String(b.get('username')), password, b.getAll('devices').map(String));
    form.reset(); if (identity) await reload(identity); setNotice('观看账户已创建。请安全交付初始密码，该账户只能查看所选设备。');
  });
  const download = () => {
    if (!credential) return;
    const url = URL.createObjectURL(new Blob([connectionInstructions(credential, serviceRoot)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `bms-connection-${credential.device.deviceId}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main className="bms-page bms-management">
    <header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>设备注册与接入</h1></div><nav aria-label="页面导航"><Link to="/bms/realtime">BMS 实时监测</Link><Link to="/">原理图</Link>{identity && <><span>{identity.username} · {identity.role === 'admin' ? '管理员' : '观看账户'}</span><button disabled={locked} onClick={() => void perform(async () => { await bmsApi.logout(); setIdentity(null); setRegistry(null); setDevices([]); setCredential(null); await bmsApi.session(); })}>退出登录</button></>}</nav></header>
    <div className="bms-content">
      <div className="bms-onboarding-steps" aria-label="接入流程"><span>① 初始化管理员</span><span>② 注册设备与账户</span><span>③ 配置 Windows 客户端</span><span>④ 网页开始观看</span></div>
      {error && <p className="bms-error" role="alert">{error}</p>}{notice && <p className="bms-notice" role="status">{notice}</p>}
      {!ready ? <p>正在读取注册状态…</p> : !setup?.enabled ? <section className="bms-admin-card"><h2>站点尚未启用实时接入</h2><p>站点管理员需要先配置注册存储和初始化密钥。完成后，这里会显示管理员初始化表单，再通过网页注册设备和观看账户。</p><p>实验人员可以先按下面的步骤确认 Windows 本地采集正常。</p></section> : !setup.initialized ? <section className="bms-admin-card bms-first-admin"><h2>首次初始化管理员</h2><p>由站点持有者使用服务器提供的初始化密钥创建首个管理员。初始化只允许完成一次；随后设备和观看账户均从这里管理。</p>{!setup.bootstrapAvailable ? <p className="bms-warning">初始化密钥或持久化注册存储尚未配置，请联系站点管理员。</p> : <form onSubmit={(e) => { e.preventDefault(); void signIn(e.currentTarget, true); }}><label>初始化密钥<input name="bootstrapToken" type="password" required autoComplete="off" minLength={32} maxLength={256} disabled={busy} /></label><label>管理员用户名<input name="username" required autoComplete="username" pattern="[a-zA-Z0-9_.-]{3,80}" minLength={3} maxLength={80} disabled={busy} /></label><label>管理员密码<input name="password" type="password" required autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} /></label><label>确认管理员密码<input name="confirmPassword" type="password" required autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} /></label><button className="bms-primary" disabled={busy}>{busy ? '正在初始化…' : '创建首个管理员'}</button></form>}</section> : !identity ? <section className="bms-login"><h2>登录设备管理</h2><p>管理员登录后可注册设备、创建观看账户和轮换令牌。观看账户可登录查看自己的接入说明；新观看账户由管理员创建。</p><form onSubmit={(e) => { e.preventDefault(); void signIn(e.currentTarget); }}><label>用户名<input name="username" autoComplete="username" required maxLength={80} disabled={busy} /></label><label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={busy} /></label><button className="bms-primary" disabled={busy}>登录</button></form></section> : identity.role !== 'admin' ? <p className="bms-notice">你当前使用观看账户。设备注册和新账户创建由管理员完成，下面展示你获准设备的本地接入说明。</p> : <>
        {!registry?.writable && <p className="bms-warning">当前部署使用只读注册配置。请运维启用持久化注册存储后再新增设备、账户或轮换令牌。</p>}
        {credential && <section className="bms-credential" aria-label="新设备接入凭据"><h2>保存设备上传令牌与本地配置</h2><p>设备：{credential.device.alias} · {credential.device.deviceId}。令牌仅在注册或轮换成功后显示一次，关闭后云端只保留散列。</p><label>设备上传令牌（仅显示一次）<input type={reveal ? 'text' : 'password'} value={credential.deviceToken} readOnly autoComplete="off" /></label><div className="bms-admin-actions"><button onClick={() => setReveal(!reveal)}>{reveal ? '隐藏令牌' : '显示令牌'}</button><button onClick={() => void navigator.clipboard.writeText(credential.deviceToken).then(() => setNotice('令牌已复制，请只填入本地客户端')).catch(() => setError('复制失败，请显示令牌后手动复制'))}>复制令牌</button><button className="bms-primary" onClick={download}>下载 Windows 配置说明（含令牌）</button><button onClick={() => { setCredential(null); setReveal(false); }}>已保存，关闭凭据</button></div><p>配置文件含私密上传令牌，请保存在 Windows 用户的安全目录，不要发到聊天、公开链接或仓库。</p></section>}
        <div className="bms-admin-forms"><section className="bms-admin-card"><h2>注册本地设备</h2><p>设备编号复制自 Windows 客户端；地址和 Pack 按实际采集值填写。</p><form onSubmit={(e) => { e.preventDefault(); void registerDevice(e.currentTarget); }}><label>设备编号 deviceId<input name="deviceId" required pattern="[a-zA-Z0-9_-]{1,80}" maxLength={80} placeholder="复制Windows客户端中的deviceId" disabled={locked || !registry?.writable} /></label><label>设备名称<input name="alias" required maxLength={128} placeholder="例如：实验室1号电池" disabled={locked || !registry?.writable} /></label><label>BMS 地址（逗号分隔）<input name="addresses" required placeholder="填写实际地址，例如1" disabled={locked || !registry?.writable} /></label><label>Pack 编号（逗号分隔）<input name="packs" required placeholder="填写实际Pack，例如1,2" disabled={locked || !registry?.writable} /></label><label className="bms-checkbox"><input name="simulation" type="checkbox" disabled={locked || !registry?.writable} />允许该设备上传模拟数据（实验验证时才开启）</label><button className="bms-primary" disabled={locked || !registry?.writable}>注册设备并生成上传令牌</button></form></section>
        <section className="bms-admin-card"><h2>创建观看账户</h2><p>观看账户只读取授权设备的数据，不能注册设备或生成上传令牌。</p><form onSubmit={(e) => { e.preventDefault(); void registerUser(e.currentTarget); }}><label>观看用户名<input name="username" required pattern="[a-zA-Z0-9_.-]{3,80}" minLength={3} maxLength={80} autoComplete="off" disabled={locked || !registry?.writable} /></label><label>观看账户初始密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked || !registry?.writable} /></label><label>确认初始密码<input name="confirmPassword" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked || !registry?.writable} /></label><fieldset disabled={locked || !registry?.writable}><legend>授权设备</legend>{!devices.length ? <p>请先注册设备。</p> : devices.map((d) => <label className="bms-checkbox" key={d.deviceId}><input type="checkbox" name="devices" value={d.deviceId} />{d.alias} · {d.deviceId}</label>)}</fieldset><button className="bms-primary" disabled={locked || !registry?.writable || !devices.length}>创建观看账户</button></form></section></div>
        <section className="bms-admin-card"><h2>已注册设备</h2>{!devices.length ? <p>还没有设备，请先完成上面的设备注册。</p> : <div className="bms-device-list">{devices.map((d) => <article key={d.deviceId}><h3>{d.alias}</h3><code>{d.deviceId}</code><p>地址：{d.allowedAddresses?.join('、')} · Pack：{d.allowedPacks.join('、')}</p><p>{d.allowSimulation ? '允许模拟数据' : '仅接收串口实测'} · {d.online ? '客户端心跳在线' : '客户端未在线'}</p><small>最后心跳：{bmsTime(d.lastHeartbeatAt)}</small><div className="bms-admin-actions"><button onClick={() => setGuideDevice(d.deviceId)}>查看本地配置步骤</button>{rotating === d.deviceId ? <><span>旧令牌将立即失效，当前观看也将结束。</span><button disabled={locked} onClick={() => void perform(async () => { const c = await bmsApi.rotateDevice(d.deviceId); setCredential(c); setReveal(false); setRotating(''); setGuideDevice(d.deviceId); if (identity) await reload(identity); })}>确认轮换</button><button onClick={() => setRotating('')}>取消</button></> : <button disabled={locked || !registry?.writable} onClick={() => { setDeleting(''); setRotating(d.deviceId); }}>轮换上传令牌</button>}{deleting === d.deviceId ? <><span>删除后上传令牌失效，观看结束，云端短缓存和所有账户对此设备的授权将移除。本地记录保留。重新接入需重新注册并配置新令牌。</span><button disabled={locked} onClick={() => void perform(async () => { await bmsApi.deleteDevice(d.deviceId); setDeleting(''); setGuideDevice((id) => id === d.deviceId ? '' : id); if (identity) await reload(identity); setNotice('设备已删除，上传令牌和观看授权已撤销；本地采集记录保留。'); })}>确认删除设备</button><button disabled={busy} onClick={() => setDeleting('')}>取消删除</button></> : <button disabled={locked || !registry?.writable} onClick={() => { setRotating(''); setDeleting(d.deviceId); }}>删除设备</button>}</div></article>)}</div>}</section>
        <section className="bms-admin-card"><h2>已创建账户</h2><ul className="bms-user-list">{registry?.users.map((u) => <li key={u.username}><strong>{u.username}</strong><span>{u.role === 'admin' ? '管理员' : '观看账户'}</span><span>授权设备：{u.devices.join('、') || '尚无设备'}</span></li>)}</ul></section>
      </>}
      {!!devices.length && <label className="bms-guide-selector">接入指南设备<select value={guideDevice} onChange={(e) => setGuideDevice(e.target.value)}><option value="">通用接入步骤</option>{devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.alias} · {d.deviceId}</option>)}</select></label>}
      <BmsConnectionGuide serviceRoot={serviceRoot} device={devices.find((d) => d.deviceId === guideDevice)} />
    </div>
  </main>;
}
