import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { bmsApi, BmsApiError, monitoringApi } from '../services/bmsRealtimeApi';
import type { BmsDevice, BmsIdentity } from '../services/bmsRealtimeTypes';
import { BmsRealtimePage } from './BmsRealtimePage';
import { ExperimentRealtimePage } from './ExperimentRealtimePage';
import './bms-realtime.css';
import './experiment-realtime.css';

function createPageId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function MonitoringDevicePage() {
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<BmsIdentity | null>(null);
  const [devices, setDevices] = useState<BmsDevice[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [pageId] = useState(createPageId);
  const requestedId = deviceId;
  const device = devices.find(candidate => candidate.deviceId === requestedId);

  useEffect(() => {
    let alive = true;
    const previousTitle = document.title;
    document.title = '设备观测 · 光伏空调实验平台';
    void (async () => {
      try {
        const user = await bmsApi.session();
        if (!alive) return;
        if (!user) { navigate('/monitoring', { replace: true }); return; }
        setIdentity(user);
        const result = await monitoringApi.devices();
        if (!alive) return;
        setDevices(result.devices);
      } catch (cause) {
        if (!alive) return;
        if (cause instanceof BmsApiError && cause.status === 401) navigate('/monitoring', { replace: true });
        else setError(cause instanceof Error ? cause.message : '设备列表暂不可用');
      } finally { if (alive) setReady(true); }
    })();
    return () => { alive = false; document.title = previousTitle; };
  }, [navigate]);

  const moduleFilter = device?.module === 'experiment' ? 'experiment' : 'bms';
  const backToList = () => navigate(`/monitoring?view=devices&module=${moduleFilter}`);
  const onUnauthorized = useCallback(() => navigate('/monitoring', {
    replace: true,
    state: { notice: '登录已失效或账户已停用，请重新登录后继续观测。' },
  }), [navigate]);
  const onPermissionRevoked = useCallback(() => navigate('/monitoring?view=devices', {
    replace: true,
    state: { notice: `你对设备“${device?.alias ?? requestedId}”的观测权限已被管理员撤销。当前观看已结束；列表只显示仍获授权的设备。` },
  }), [navigate, device?.alias, requestedId]);

  return <main className="bms-page monitoring-detail-page">
    <header className="bms-header"><div><span className="bms-eyebrow">光伏 · 空调实验平台</span><h1>{device?.alias ?? '设备观测'}</h1></div><nav aria-label="观测导航"><Link to={`/monitoring?view=devices&module=${moduleFilter}`}>← 返回设备列表</Link>{identity && <span>{identity.username}</span>}</nav></header>
    <div className="bms-content">
      {!ready ? <section className="bms-login">正在读取设备权限…</section> : error ? <section className="monitoring-empty"><h2>设备列表暂不可用</h2><p role="alert">{error}</p><button onClick={() => navigate('/monitoring', { replace: true })}>返回实时观测</button></section> : !device ? <section className="monitoring-empty"><h2>无权查看此设备</h2><p>设备不存在或当前账户没有观测权限。请联系管理员；设备列表只展示你获准查看的设备。</p><button onClick={backToList}>返回设备列表</button></section> : device.module === 'experiment' ? <ExperimentRealtimePage key={device.deviceId} embedded identity={identity!} device={device} autostart pageId={pageId} onUnauthorized={onUnauthorized} onPermissionRevoked={onPermissionRevoked} /> : <BmsRealtimePage key={device.deviceId} embedded identity={identity!} device={device} autostart pageId={pageId} onUnauthorized={onUnauthorized} onPermissionRevoked={onPermissionRevoked} />}
    </div>
  </main>;
}
