import { isClientForeground, subscribeClientForeground } from '../services/clientForeground';
import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { experimentApi } from '../services/experimentRealtimeApi';
import { ExperimentRealtimeController } from '../services/experimentRealtimeController';
import {
  experimentCatalog,
  experimentTime,
  experimentAgeLabel,
  pointStatus,
  latestExperimentSamples,
  experimentTrendKey,
  buildExperimentTrendLines,
} from '../services/experimentRealtimeTypes';
import type { PointDefinition } from '../services/experimentRealtimeTypes';
import { sourceLabel } from '../services/realtimeSource';
import { useExperimentRealtimeStore as store } from '../store/experimentRealtime';
import { MonitoringTrendChart } from '../components/bmsRealtime/MonitoringTrendChart';
import type { BmsDevice, BmsIdentity } from '../services/bmsRealtimeTypes';
import './bms-realtime.css';
import './experiment-realtime.css';

const groups = ['温度', '实验电表', '市电', '太阳能', '运行状态', '诊断'] as const;
const electricalGroups = ['实验电表', '市电', '太阳能'] as const;

export interface ExperimentRealtimePageProps {
  embedded?: boolean;
  identity?: BmsIdentity;
  device?: BmsDevice | null;
  autostart?: boolean;
  pageId?: string;
  onUnauthorized?: () => void;
  onPermissionRevoked?: (deviceId: string) => void;
}

export function ExperimentRealtimePage(props: ExperimentRealtimePageProps = {}) {
  if (!props.identity || !props.device) return <Navigate to="/monitoring?view=devices&module=experiment" replace />;
  return <ExperimentObservation {...props} identity={props.identity} device={props.device} />;
}

function ExperimentObservation({
  identity,
  device,
  autostart,
  pageId,
  onUnauthorized,
  onPermissionRevoked,
}: ExperimentRealtimePageProps & { identity: BmsIdentity; device: BmsDevice }) {
  const state = store();
  const controller = useRef(new ExperimentRealtimeController());
  const resume = useRef(false);
  const initialized = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [mono, setMono] = useState(performance.now());
  const [clearing, setClearing] = useState(false);

  const currentDevice = state.devices.find(d => d.deviceId === device.deviceId) ?? device;
  const online = !!currentDevice.online && !!currentDevice.lastHeartbeatAt && now - Date.parse(currentDevice.lastHeartbeatAt) < 45000;
  const watching = ['connecting', 'watching', 'reconnecting'].includes(state.phase);
  const samples = latestExperimentSamples(Object.values(state.samples));
  const byEquipment = new Map(samples.map(sample => [sample.snapshot.equipmentId, sample]));
  const includesSimulation = samples.some(sample => sample.snapshot.source === 'simulation');
  const definitions = experimentCatalog.points.filter(point => device.allowedEquipment?.includes(point.equipmentId));
  const trendableDefinitions = definitions.filter(point => point.metadata.Group !== '运行状态' && point.metadata.Group !== '诊断');
  const selected = trendableDefinitions.find(point => `${point.equipmentId}/${point.id}` === state.selection) ?? trendableDefinitions[0] ?? definitions[0];
  const last = samples.reduce<(typeof samples)[number] | undefined>(
    (previous, sample) => !previous || sample.acceptedOrder > previous.acceptedOrder ? sample : previous,
    undefined,
  );

  const pointContext = (definition: PointDefinition) => {
    const sample = byEquipment.get(definition.equipmentId);
    const point = sample?.snapshot.points.find(item => item.id === definition.id);
    const view = pointStatus(point, mono);
    const history = sample ? state.lastGoodByPoint[`${sample.snapshot.source}/${definition.equipmentId}/${definition.id}`] : undefined;
    return { sample, point, view, history };
  };
  const goodCount = definitions.filter(definition => pointContext(definition).view.good).length;
  const observedCount = definitions.filter(definition => !!pointContext(definition).point).length;
  const issueCount = definitions.filter(definition => {
    const { point, view } = pointContext(definition);
    return !!point && !view.good;
  }).length;

  useEffect(() => {
    controller.current.setPermissionRevokedHandler(onPermissionRevoked);
    return () => controller.current.setPermissionRevokedHandler(undefined);
  }, [onPermissionRevoked]);

  useEffect(() => {
    if (initialized.current && state.phase === 'unauthorized' && !state.identity) onUnauthorized?.();
  }, [state.identity, state.phase, onUnauthorized]);

  useEffect(() => {
    const current = controller.current;
    const old = store.getState();
    initialized.current = true;
    if (old.deviceId !== device.deviceId || old.identity?.username !== identity.username) old.clearData();
    const first = experimentCatalog.points.find(point => device.allowedEquipment?.includes(point.equipmentId) && point.metadata.Group !== '运行状态' && point.metadata.Group !== '诊断');
    const oldDefinition = experimentCatalog.points.find(point => `${point.equipmentId}/${point.id}` === old.selection);
    const keepOldSelection = !!oldDefinition && device.allowedEquipment?.includes(oldDefinition.equipmentId) && oldDefinition.metadata.Group !== '运行状态' && oldDefinition.metadata.Group !== '诊断';
    store.setState({
      identity,
      devices: [device],
      deviceId: device.deviceId,
      error: '',
      selection: keepOldSelection ? old.selection : first ? `${first.equipmentId}/${first.id}` : 'PLC/T0',
    });
    resume.current = !!autostart && !isClientForeground();
    if (autostart && isClientForeground()) void current.start(pageId);

    const timer = setInterval(() => {
      setNow(Date.now());
      setMono(performance.now());
    }, 1000);
    const visibility = () => {
      if (!isClientForeground()) {
        resume.current = ['connecting', 'watching', 'reconnecting'].includes(store.getState().phase);
        if (resume.current) current.stop('paused');
      } else if (resume.current) {
        resume.current = false;
        void current.start(pageId);
      }
    };
    const unsubscribeForeground = subscribeClientForeground(visibility);
    return () => {
      clearInterval(timer);
      unsubscribeForeground();
      resume.current = false;
      current.stop();
    };
  }, [device.deviceId, identity.username, autostart, pageId]);

  const selectPoint = (definition: PointDefinition) => {
    const selection = `${definition.equipmentId}/${definition.id}`;
    store.setState({
      selection,
      trend: state.trendByPoint[experimentTrendKey(device.deviceId, selection)] ?? [],
    });
    void controller.current.updateHistorySelection(selection);
    void controller.current.refreshTrend();
  };

  const selectedTrend = selected && selected.metadata.Group !== '运行状态' && selected.metadata.Group !== '诊断' ? (() => {
    const selection = `${selected.equipmentId}/${selected.id}`;
    const point = byEquipment.get(selected.equipmentId)?.snapshot.points.find(item => item.id === selected.id);
    const unit = point?.unit ?? selected.metadata.Unit;
    const points = state.trendByPoint[experimentTrendKey(device.deviceId, selection)] ?? [];
    return {
      selection,
      unit,
      chart: <MonitoringTrendChart
        title={`${selected.metadata.Label} · ${selected.id}`}
        unit={unit}
        series={buildExperimentTrendLines(selection, unit, points)}
        gapMs={Infinity}
      />,
    };
  })() : null;

  const compactCard = (definition: PointDefinition) => {
    const { sample, point, view, history } = pointContext(definition);
    const selection = `${definition.equipmentId}/${definition.id}`;
    const selectedCard = state.selection === selection;
    const historical = !view.good && history && !pointStatus(history, mono).expired ? history : undefined;
    return <button
      type="button"
      key={selection}
      className={`experiment-live-card ${view.good ? '' : 'is-muted'} ${selectedCard ? 'is-selected' : ''}`}
      onClick={() => selectPoint(definition)}
      aria-pressed={selectedCard}
    >
      <span className="experiment-live-card__head"><b>{definition.metadata.Label}</b><code>{definition.id}</code></span>
      <span className="experiment-live-card__value"><strong>{view.value}</strong><em>{point?.unit ?? definition.metadata.Unit}</em></span>
      <span className={`experiment-live-card__quality ${view.good ? '' : 'is-warning'}`}>
        {view.label}{!definition.metadata.ScaleConfirmed ? ' · 倍率待核准' : ''}
      </span>
      <span className="experiment-live-card__meta">
        {definition.equipmentId} · {sourceLabel(sample?.snapshot.source)} · {experimentAgeLabel(point, mono)}
      </span>
      {historical && <span className="experiment-live-card__historic">
        最近有效：{historical.value ?? historical.displayValue} {historical.unit} · {experimentTime(historical.observedUtc)}
      </span>}
    </button>;
  };

  const stateCard = (definition: PointDefinition) => {
    const { sample, point, view, history } = pointContext(definition);
    const historical = !view.good && history && !pointStatus(history, mono).expired ? history : undefined;
    return <article key={`${definition.equipmentId}/${definition.id}`} className={`experiment-state-card ${view.good ? '' : 'is-muted'}`}>
      <span className="experiment-live-card__head"><b>{definition.metadata.Label}</b><code>{definition.id}</code></span>
      <span className="experiment-live-card__value"><strong>{view.value}</strong><em>{point?.unit ?? definition.metadata.Unit}</em></span>
      <span className={`experiment-live-card__quality ${view.good ? '' : 'is-warning'}`}>{view.label}</span>
      <span className="experiment-live-card__meta">{definition.equipmentId} · {sourceLabel(sample?.snapshot.source)} · {experimentAgeLabel(point, mono)}</span>
      <span className="experiment-live-card__hint">原始状态码，现场语义映射未确认</span>
      {historical && <span className="experiment-live-card__historic">最近有效：{historical.value ?? historical.displayValue} {historical.unit} · {experimentTime(historical.observedUtc)}</span>}
    </article>;
  };

  const status = state.phase === 'paused' ? '观看已暂停'
    : state.phase === 'unauthorized' ? '观看权限失效'
      : state.phase === 'reconnecting' ? '网站连接中断，正在重连'
        : state.phase === 'connecting' ? '正在建立观看'
          : !watching ? '未连接观看'
            : !online ? '本地程序未在线 / 等待本地程序'
              : '实验实时观测中';

  return <section className="experiment-page experiment-observation" aria-label="实验设备实时观测">
    <p className="bms-notice">只读观测 · 本地程序负责采集、SQLite 完整记录与设备通信，网页不控制设备。心跳在线不等于采集正常。</p>
    {state.error && <p className="bms-error" role="alert">{state.error}</p>}

    <section className="bms-toolbar experiment-observe-toolbar" aria-label="实验观看设置">
      <div>
        <span>云端观测</span>
        <strong>{device.alias}</strong>
        <small>{definitions.length} 个授权测点 · {device.allowedEquipment?.length ?? 0} 台仪器</small>
      </div>
      {watching
        ? <button onClick={() => { resume.current = false; controller.current.stop(); }}>暂停观测</button>
        : <button className="bms-primary" disabled={state.phase === 'unauthorized'} onClick={() => void controller.current.start(pageId)}>开始云端观测</button>}
    </section>

    <section className={`bms-status ${online && watching ? 'is-fresh' : ''}`} aria-live="polite">
      <div className="bms-status-title"><span className="bms-dot" /><strong>{status}</strong>{includesSimulation && <span className="bms-simulation">包含模拟数据</span>}</div>
      <div className="bms-status-grid">
        <div><span>网站数据连接</span><b>{state.websiteConnected ? '已连通' : '未连通'}</b></div>
        <div><span>采集端心跳</span><b>{online ? '在线' : '未在线'}</b><small>{experimentTime(currentDevice.lastHeartbeatAt)}</small></div>
        <div><span>观看租约</span><b>{state.lease ? '已建立' : '未建立'}</b><small>{experimentTime(state.lease?.expiresAt)}</small></div>
        <div><span>最后快照组装</span><b>{experimentTime(last?.snapshot.capturedUtc)}</b><small>各测点保留自己的观测时间</small></div>
      </div>
      <p>测点是否“有效”只服从本地质量字段；年龄单独显示。失败、旧数据、null 和未采集不会变成 0，也不会跨来源回填。</p>
    </section>

    {last && Math.abs(Date.parse(last.snapshot.capturedUtc) - Date.parse(last.receivedAt)) > 60000 &&
      <p className="bms-warning">采集机与服务器时间可能有偏差，请核对系统时钟。页面继续保留原始观测时间。</p>}

    <section className="experiment-overview" aria-label="实验实时总览">
      <div className="experiment-section-head">
        <div><span>实时总览</span><h2>先判断采集健康，再查看具体测点</h2></div>
        <p>这里是当前云端短缓存的最新状态，不替代本地实验记录。</p>
      </div>
      <div className="experiment-overview-grid">
        <article><span>有效测点</span><strong>{goodCount}</strong><small>/ {definitions.length} 个授权测点</small></article>
        <article><span>已观测测点</span><strong>{observedCount}</strong><small>{definitions.length - observedCount} 个尚未出现</small></article>
        <article><span>异常/非有效</span><strong>{issueCount}</strong><small>保持本地质量语义</small></article>
        <article><span>已见仪器</span><strong>{samples.length}</strong><small>/ {device.allowedEquipment?.length ?? 0} 台授权仪器</small></article>
      </div>
      <div className="experiment-source-strip">
        {(device.allowedEquipment ?? []).map(equipmentId => {
          const sample = byEquipment.get(equipmentId);
          return <span key={equipmentId} className={sample ? 'is-seen' : ''}><b>{equipmentId}</b>{sample ? sourceLabel(sample.snapshot.source) : '等待快照'}</span>;
        })}
      </div>
    </section>

    {definitions.some(point => point.metadata.Group === '温度') && <section className="experiment-live-section" id="experiment-temperature">
      <div className="experiment-section-head">
        <div><span>热工测点</span><h2>温度矩阵</h2></div>
        <p>七个温度测点优先显示当前值、质量和采集年龄；点击任一测点查看其真实短趋势。</p>
      </div>
      <div className="experiment-live-grid experiment-live-grid--temperature">
        {definitions.filter(point => point.metadata.Group === '温度').map(point => compactCard(point))}
      </div>
    </section>}

    <section className="experiment-live-section">
      <div className="experiment-section-head">
        <div><span>电气与能源</span><h2>实验电表 · 市电 · 太阳能</h2></div>
        <p>倍率尚未现场核准的测点保留工程原值和显式提示，不在网页二次换算。</p>
      </div>
      <div className="experiment-electrical-groups">
        {electricalGroups.filter(group => definitions.some(point => point.metadata.Group === group)).map(group =>
          <section key={group}>
            <h3>{group}</h3>
            <div className="experiment-live-grid">
              {definitions.filter(point => point.metadata.Group === group).map(point => compactCard(point))}
            </div>
          </section>)}
      </div>
    </section>

    {definitions.some(point => point.metadata.Group === '运行状态') && <section className="experiment-live-section">
      <div className="experiment-section-head">
        <div><span>离散状态</span><h2>运行状态</h2></div>
        <p>当前协议只确认原始状态码，尚未确认现场语义映射，因此不擅自显示“开/关/故障”等解释。</p>
      </div>
      <div className="experiment-state-grid">
        {definitions.filter(point => point.metadata.Group === '运行状态').map(point => stateCard(point))}
      </div>
    </section>}

    {selectedTrend && <section className="experiment-main-trend" aria-label="实验主趋势">
      <div className="experiment-section-head">
        <div><span>变化趋势</span><h2>{selected?.metadata.Label}</h2></div>
        <label>趋势测点
          <select value={selectedTrend.selection} onChange={event => {
            const definition = definitions.find(point => `${point.equipmentId}/${point.id}` === event.target.value);
            if (definition) selectPoint(definition);
          }}>
            {trendableDefinitions.map(point =>
              <option key={`${point.equipmentId}/${point.id}`} value={`${point.equipmentId}/${point.id}`}>
                {point.metadata.Group} · {point.metadata.Label} · {point.id}
              </option>)}
          </select>
        </label>
      </div>
      {selectedTrend.chart}
      <p>只绘制实际收到的观测点，不插值、不补点；来源、连接会话和本地失败/null 观测形成断点。现在只按需读取当前选中测点的趋势。</p>
    </section>}

    <section className="experiment-diagnostics">
      <div className="experiment-section-head">
        <div><span>高级信息</span><h2>全部测点与数据诊断</h2></div>
        <p>寄存器地址、原始值、配置版本和采集轮次放在诊断层，默认不占用实时监测主界面。</p>
      </div>
      {groups.filter(group => definitions.some(point => point.metadata.Group === group)).map(group => <details key={group}>
        <summary>{group}<span>{definitions.filter(point => point.metadata.Group === group).length} 个测点</span></summary>
        <div className="experiment-diagnostic-grid">
          {definitions.filter(point => point.metadata.Group === group).map(definition => {
            const { sample, point, view, history } = pointContext(definition);
            return <article key={`${definition.equipmentId}/${definition.id}`} className={view.good ? '' : 'is-muted'}>
              <header><div><h3>{definition.metadata.Label}</h3><code>{definition.id}</code></div>{definition.metadata.Group !== '运行状态' && definition.metadata.Group !== '诊断' && <button type="button" onClick={() => selectPoint(definition)}>查看趋势</button>}</header>
              <p><strong>{view.value}</strong> {point?.unit ?? definition.metadata.Unit} · {view.label}</p>
              <small>{definition.equipmentId} · 站号 {definition.slave} · {sourceLabel(sample?.snapshot.source)} · {experimentAgeLabel(point, mono)}</small>
              {!definition.metadata.ScaleConfirmed && <p className="experiment-diagnostic-warning">倍率待核准，当前显示工程原值。</p>}
              {!view.good && history && !pointStatus(history, mono).expired && <p>最近有效历史：{history.value ?? history.displayValue} {history.unit} · {experimentTime(history.observedUtc)}（非当前读数）</p>}
              {point
                ? <details><summary>原始值与寄存器</summary>
                    <p>原始值：{point.rawValue ?? '—'}；客户端显示：{point.displayValue || '—'}</p>
                    <p>质量：{point.quality}；轮次：{point.acquisitionRound}；配置：{point.configVersion}</p>
                    <p>观测：{experimentTime(point.observedUtc)}；接收：{experimentTime(point.receivedAt)}</p>
                    <p>零基地址：{definition.addressZeroBased}；寄存器数：{definition.registerCount}；解码：{point.decodeMode}</p>
                  </details>
                : <p>尚未收到该测点观测。</p>}
            </article>;
          })}
        </div>
      </details>)}
    </section>

    <footer className="bms-footer">
      <span>完整实验记录、串口配置、跨分区历史与导出仍由本地客户端负责。</span>
      {state.capacityWarning && <span className="bms-warning">缓存容量不足，新观测已被拒绝；已有历史仍保留。</span>}
      {identity.role === 'admin' && (clearing
        ? <div><span>清理当前设备的短缓存？</span><button onClick={async () => {
            try {
              await experimentApi.clear(device.deviceId);
              store.getState().clearData();
              setClearing(false);
            } catch (error) {
              store.setState({ error: (error as Error).message });
            }
          }}>确认清理</button><button onClick={() => setClearing(false)}>取消</button></div>
        : <button onClick={() => setClearing(true)}>清理设备短缓存</button>)}
    </footer>
  </section>;
}
