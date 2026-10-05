import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { bmsApi, BmsApiError } from '../services/bmsRealtimeApi';
import type { BmsDevice, BmsDeviceCredential, BmsIdentity, BmsRegistry, BmsSetupStatus } from '../services/bmsRealtimeTypes';
import { bmsTime } from '../services/bmsRealtimeTypes';
import { connectionInstructions, registrationNumbers } from '../services/bmsRegistration';
import { BmsConnectionGuide } from '../components/bmsRealtime/BmsConnectionGuide';
import { ExperimentConnectionGuide } from '../components/bmsRealtime/ExperimentConnectionGuide';
import { EXPERIMENT_EQUIPMENT } from '../services/experimentRealtimeTypes';
import { DeploymentVersion } from '../components/DeploymentVersion';
import './bms-realtime.css';
import './bms-manage.css';

export function BmsManagePage() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<BmsSetupStatus | null>(null);
  const [identity, setIdentity] = useState<BmsIdentity | null>(null);
  const [registry, setRegistry] = useState<BmsRegistry | null>(null);
  const [devices, setDevices] = useState<BmsDevice[]>([]);
  const [registrationModule, setRegistrationModule] = useState<'bms' | 'experiment'>('bms');
  const [guideDevice, setGuideDevice] = useState('');
  const [credential, setCredential] = useState<BmsDeviceCredential | null>(null);
  const [reveal, setReveal] = useState(false);
  const [rotating, setRotating] = useState('');
  const [deleting, setDeleting] = useState('');
  const [editingUser, setEditingUser] = useState('');
  const [resettingUser, setResettingUser] = useState('');
  const [pendingPasswordReset, setPendingPasswordReset] = useState<{ username: string; password: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const serviceRoot = setup?.serviceRoot ?? window.location.origin;
  const locked = busy || !!credential || !!pendingPasswordReset || !!deleting || !!rotating;

  const reload = async () => {
    const result = await bmsApi.registry();
    setRegistry(result); setDevices(result.devices);
  };

  useEffect(() => {
    let alive = true;
    const previousTitle = document.title;
    document.title = '设备与账户管理';
    void (async () => {
      try {
        const status = await bmsApi.setupStatus();
        if (!alive) return;
        setSetup(status);
        if (status.enabled && status.initialized) {
          const user = await bmsApi.session();
          if (!alive) return;
          if (!user || user.role !== 'admin') { navigate('/monitoring', { replace: true }); return; }
          setIdentity(user);
          const result = await bmsApi.registry();
          if (alive) { setRegistry(result); setDevices(result.devices); }
        }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : '无法读取管理状态'); }
      finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; document.title = previousTitle; };
  }, [navigate]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) {
      if (cause instanceof BmsApiError && (cause.status === 401 || cause.status === 403)) navigate('/monitoring', { replace: true });
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally { setBusy(false); }
  };

  const bootstrap = (form: HTMLFormElement) => perform(async () => {
    const values = new FormData(form), password = String(values.get('password'));
    if (password !== values.get('confirmPassword')) throw new Error('两次密码不一致');
    const user = await bmsApi.bootstrap(String(values.get('username')), password, String(values.get('bootstrapToken')));
    setSetup(current => current ? { ...current, initialized: true, bootstrapAvailable: false } : current);
    setIdentity(user); form.reset();
    const result = await bmsApi.registry(); setRegistry(result); setDevices(result.devices);
    setNotice('管理员初始化完成。现在可以注册设备并创建观察账户。');
  });

  const registerDevice = (form: HTMLFormElement) => perform(async () => {
    const values = new FormData(form);
    const created = await bmsApi.registerDevice({
      deviceId: String(values.get('deviceId')).trim(), alias: String(values.get('alias')).trim(), module: registrationModule,
      ...(registrationModule === 'bms'
        ? { allowedAddresses: registrationNumbers(String(values.get('addresses')), 255), allowedPacks: registrationNumbers(String(values.get('packs')), 16) }
        : { allowedEquipment: values.getAll('equipment').map(String) }),
      allowSimulation: false,
    });
    setCredential(created); setReveal(false); setGuideDevice(created.device.deviceId); form.reset();
    await reload();
  });

  const registerUser = (form: HTMLFormElement) => perform(async () => {
    const values = new FormData(form), password = String(values.get('password'));
    if (password !== values.get('confirmPassword')) throw new Error('两次密码不一致');
    const devices = values.getAll('devices').map(String);
    await bmsApi.registerUser(String(values.get('username')), password, devices);
    form.reset(); await reload(); setNotice(devices.length ? '观察账户已创建。请通过安全渠道交付初始密码。' : '账户已创建，当前未分配观测设备。请通过安全渠道交付初始密码。');
  });

  const download = () => {
    if (!credential) return;
    const url = URL.createObjectURL(new Blob([connectionInstructions(credential, serviceRoot)], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${credential.device.module === 'experiment' ? 'experiment' : 'bms'}-connection-${credential.device.deviceId}.txt`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const confirmPasswordReset = () => {
    const pending = pendingPasswordReset;
    if (!pending) return;
    void perform(async () => {
      await bmsApi.resetUserPassword(pending.username, pending.password);
      setPendingPasswordReset(null); setResettingUser(''); await reload(); setNotice(`账户 ${pending.username} 的密码已重置。请通过安全渠道通知该用户。`);
    });
  };

  const logout = () => perform(async () => { await bmsApi.logout(); setIdentity(null); navigate('/monitoring', { replace: true }); });

  return <main className="bms-page bms-management">
    <header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>设备与账户管理</h1><DeploymentVersion /></div><nav aria-label="管理导航"><Link to="/monitoring?view=devices">实时观测设备</Link><Link to="/">原理图</Link>{identity && <><span>{identity.username} · 管理员</span><button disabled={locked} onClick={() => void logout()}>退出登录</button></>}</nav></header>
    <div className="bms-content">
      {error && <p className="bms-error" role="alert">{error}</p>}{notice && <p className="bms-notice" role="status">{notice}</p>}
      {!ready ? <p>正在读取注册状态…</p> : !setup?.enabled ? <section className="bms-admin-card"><h2>站点尚未启用实时接入</h2><p>请先配置注册存储和初始化密钥。</p></section> : !setup.initialized ? <section className="bms-admin-card bms-first-admin"><h2>首次初始化管理员</h2><p>使用服务器提供的一次性初始化密钥创建首个管理员。</p>{!setup.bootstrapAvailable ? <p className="bms-warning">初始化密钥或持久化注册存储尚未配置，请联系运维人员。</p> : <form onSubmit={event => { event.preventDefault(); void bootstrap(event.currentTarget); }}><label>初始化密钥<input name="bootstrapToken" type="password" required autoComplete="off" minLength={32} maxLength={256} disabled={busy} /></label><label>管理员用户名<input name="username" required autoComplete="username" pattern="[a-zA-Z0-9_.-]{3,80}" minLength={3} maxLength={80} disabled={busy} /></label><label>管理员密码<input name="password" type="password" required autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} /></label><label>确认管理员密码<input name="confirmPassword" type="password" required autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} /></label><button className="bms-primary" disabled={busy}>{busy ? '正在初始化…' : '创建首个管理员'}</button></form>}</section> : identity?.role === 'admin' && <>
        {!registry?.writable && <p className="bms-warning">当前部署使用只读注册配置，无法新增设备、账户或轮换令牌。</p>}
        <section className="bms-admin-card bms-system-settings"><h2>独立设备接入</h2><p>每台设备对应一个 Windows 上传程序。实验设备包含其授权仪器，BMS 设备包含其全部 Pack；授权账户后可查看该设备的全部内容。</p><p>注册后保存一次性令牌和 Windows 手动配置说明，再从实时观测设备列表打开设备验证数据。</p></section>
        {credential && <section className="bms-credential" aria-label="新设备接入凭据"><h2>保存设备上传令牌与 Windows 配置说明</h2><p>设备：{credential.device.alias} · {credential.device.deviceId}。令牌仅显示一次，关闭后云端只保留散列。</p><label>设备上传令牌（仅显示一次）<input type={reveal ? 'text' : 'password'} value={credential.deviceToken} readOnly autoComplete="off" /></label><div className="bms-admin-actions"><button onClick={() => setReveal(!reveal)}>{reveal ? '隐藏令牌' : '显示令牌'}</button><button onClick={() => void navigator.clipboard.writeText(credential.deviceToken).then(() => setNotice('令牌已复制，请只填入本地客户端')).catch(() => setError('复制失败，请显示令牌后手动复制'))}>复制令牌</button><button className="bms-primary" onClick={download}>下载 Windows 配置说明（含令牌）</button><button onClick={() => { setCredential(null); setReveal(false); }}>已安全保存，关闭凭据</button></div><p>配置文件含私密上传令牌，请保存在 Windows 用户的安全目录。</p></section>}
        <div className="bms-admin-forms"><section className="bms-admin-card"><h2>注册本地设备</h2><form onSubmit={event => { event.preventDefault(); void registerDevice(event.currentTarget); }}><label>采集模块<select value={registrationModule} disabled={locked} onChange={event => setRegistrationModule(event.target.value as 'bms' | 'experiment')}><option value="bms">BMS 电池监控</option><option value="experiment">实验监控（37测点）</option></select></label><label>设备编号 deviceId<input name="deviceId" required pattern="[a-zA-Z0-9_-]{1,80}" maxLength={80} placeholder="复制 Windows 客户端中的 deviceId" disabled={locked || !registry?.writable} /></label><label>设备名称<input name="alias" required maxLength={128} placeholder="例如：实验室1号设备" disabled={locked || !registry?.writable} /></label>{registrationModule === 'bms' ? <><label>BMS 地址（逗号分隔）<input name="addresses" required placeholder="例如 1" disabled={locked || !registry?.writable} /></label><label>Pack 编号（逗号分隔）<input name="packs" required placeholder="例如 1,2" disabled={locked || !registry?.writable} /></label></> : <fieldset disabled={locked || !registry?.writable}><legend>该程序采集的仪器</legend>{EXPERIMENT_EQUIPMENT.map(id => <label className="bms-checkbox" key={id}><input type="checkbox" name="equipment" value={id} defaultChecked />{id}</label>)}</fieldset>}<button className="bms-primary" disabled={locked || !registry?.writable}>注册设备并生成上传令牌</button></form></section>
          <section className="bms-admin-card"><h2>创建观察账户</h2><p>可以暂不分配设备，之后再编辑设备权限。</p><form onSubmit={event => { event.preventDefault(); void registerUser(event.currentTarget); }}><label>用户名<input name="username" required pattern="[a-zA-Z0-9_.-]{3,80}" minLength={3} maxLength={80} autoComplete="off" disabled={locked || !registry?.writable} /></label><label>初始密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked || !registry?.writable} /></label><label>确认初始密码<input name="confirmPassword" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked || !registry?.writable} /></label><fieldset disabled={locked || !registry?.writable}><legend>授权设备（可不选）</legend>{!devices.length ? <p>目前没有设备。</p> : devices.map(device => <label className="bms-checkbox" key={device.deviceId}><input type="checkbox" name="devices" value={device.deviceId} />{device.alias} · {device.module === 'experiment' ? '实验采集' : 'BMS'} · {device.deviceId}</label>)}</fieldset><button className="bms-primary" disabled={locked || !registry?.writable}>创建观察账户</button></form></section></div>
        <section className="bms-admin-card"><h2>已注册设备</h2>{!devices.length ? <p>还没有设备，请先完成设备注册。</p> : <div className="bms-device-list">{devices.map(device => <article key={device.deviceId}><h3>{device.alias}</h3><code>{device.deviceId}</code><p>{device.module === 'experiment' ? `实验采集 · 仪器：${device.allowedEquipment?.join('、')}` : `BMS · 地址：${device.allowedAddresses?.join('、')} · Pack：${device.allowedPacks.join('、')}`}</p><p>{device.online ? '客户端心跳在线' : '客户端心跳离线'}</p><small>最后心跳：{bmsTime(device.lastHeartbeatAt)}（心跳不代表测点新鲜）</small><div className="bms-admin-actions"><button disabled={locked} onClick={() => setGuideDevice(device.deviceId)}>查看 Windows 配置步骤</button>{rotating === device.deviceId ? <><span>旧令牌会立即失效，当前观看也会结束。</span><button disabled={busy} onClick={() => void perform(async () => { const next = await bmsApi.rotateDevice(device.deviceId); setCredential(next); setReveal(false); setGuideDevice(device.deviceId); setRotating(''); await reload(); })}>确认轮换</button><button disabled={busy} onClick={() => setRotating('')}>取消</button></> : <button disabled={locked || !registry?.writable} onClick={() => { setDeleting(''); setRotating(device.deviceId); }}>轮换上传令牌</button>}{deleting === device.deviceId ? <><span>删除将撤销该设备令牌和所有账户对该设备的授权，并清除云端短缓存。本地采集记录保留。</span><button disabled={busy} onClick={() => void perform(async () => { await bmsApi.deleteDevice(device.deviceId); setDeleting(''); setGuideDevice(id => id === device.deviceId ? '' : id); await reload(); setNotice('设备已删除；本地采集记录保留。'); })}>确认删除设备</button><button disabled={busy} onClick={() => setDeleting('')}>取消删除</button></> : <button disabled={locked || !registry?.writable} onClick={() => { setRotating(''); setDeleting(device.deviceId); }}>删除设备</button>}</div></article>)}</div>}</section>
        <section className="bms-admin-card"><h2>账户权限与状态</h2><ul className="bms-user-list">{registry?.users.map(user => <li key={user.username}><strong>{user.username}</strong><span>{user.role === 'admin' ? '管理员' : '观察账户'}</span><span>{user.disabled ? '已停用' : '正常'}</span><span>设备：{(user.effectiveDeviceIds ?? user.devices).join('、') || '未授权设备'}</span>{user.role === 'viewer' && <button disabled={locked || !registry.writable} onClick={() => { setEditingUser(user.username); setResettingUser(''); }}>修改设备权限</button>}{user.username !== identity.username && <button disabled={locked || !registry?.writable} onClick={() => { setResettingUser(user.username); setEditingUser(''); }}>重置密码</button>}</li>)}</ul>
          {editingUser && (() => { const target = registry?.users.find(user => user.username === editingUser); if (!target) return null; const selected = target.effectiveDeviceIds ?? target.devices; return <form key={editingUser} className="bms-user-edit" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget), devicesNext = data.getAll('devices').map(String); void perform(async () => { await bmsApi.updateUser(editingUser, { devices: devicesNext, disabled: data.get('disabled') === 'on' }); setEditingUser(''); await reload(); setNotice('账户设备权限与状态已原子更新；失去权限的观看会话已结束。'); }); }}><h3>修改 {editingUser} 的设备权限</h3><fieldset disabled={locked}><legend>可观测设备</legend>{devices.map(device => <label className="bms-checkbox" key={device.deviceId}><input type="checkbox" name="devices" value={device.deviceId} defaultChecked={selected.includes(device.deviceId)} />{device.alias} · {device.module === 'experiment' ? '实验采集' : 'BMS'} · {device.deviceId}</label>)}</fieldset><label className="bms-checkbox"><input type="checkbox" name="disabled" defaultChecked={!!target.disabled} disabled={locked} />停用该账户并撤销当前登录与观看</label><div className="bms-admin-actions"><button className="bms-primary" disabled={locked}>保存账户设置</button><button type="button" disabled={busy} onClick={() => setEditingUser('')}>取消</button></div></form>; })()}
          {resettingUser && !pendingPasswordReset && <form key={`reset/${resettingUser}`} className="bms-user-edit" onSubmit={event => { event.preventDefault(); const password = String(new FormData(event.currentTarget).get('password')); setPendingPasswordReset({ username: resettingUser, password }); }}><h3>重置 {resettingUser} 的密码</h3><label>新密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" disabled={locked} /></label><div className="bms-admin-actions"><button className="bms-primary" disabled={locked}>继续</button><button type="button" disabled={busy} onClick={() => setResettingUser('')}>取消</button></div></form>}
          {pendingPasswordReset && <div className="bms-inline-confirm" role="alert"><strong>确认重置密码</strong><p>将为账户 {pendingPasswordReset.username} 设置输入的新密码。系统不会再次显示。</p><div className="bms-admin-actions"><button className="bms-primary" disabled={busy} onClick={confirmPasswordReset}>确认重置</button><button disabled={busy} onClick={() => { setPendingPasswordReset(null); setResettingUser(''); }}>取消</button></div></div>}
        </section>
        {!!devices.length && <label className="bms-guide-selector">Windows 配置设备<select disabled={locked} value={guideDevice} onChange={event => setGuideDevice(event.target.value)}><option value="">选择已注册设备</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.alias} · {device.deviceId}</option>)}</select></label>}
        {(devices.find(device => device.deviceId === guideDevice)?.module ?? registrationModule) === 'experiment' ? <ExperimentConnectionGuide serviceRoot={serviceRoot} device={devices.find(device => device.deviceId === guideDevice)} /> : <BmsConnectionGuide serviceRoot={serviceRoot} device={devices.find(device => device.deviceId === guideDevice)} />}
      </>}
    </div>
  </main>;
}
