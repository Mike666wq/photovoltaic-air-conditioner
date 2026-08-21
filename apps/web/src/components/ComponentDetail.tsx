import { useEffect, useState } from 'react';
import { useSimStore } from '../store/simulation';
import { ImportDataDialog } from './ImportDataDialog';
import { readCell, buildPcmInjectData } from '../services/meterInject';
import { PCM_COLUMNS } from '../services/pdfFieldMap';
import { useAnalysisStore } from '../store/analysis';
import { deriveInverterMode, deriveStaticBatteryMode } from '../engine/schematicControl';

/**
 * 数据报表（M2-A）：展示已导入数据集的摘要 + 前 5 行原始数据
 * 未导入 → 提示用户先导入
 */
function DatasetReport() {
  const dataset = useSimStore((s) => s.injectionDataset);
  const timelineIndex = useSimStore((s) => s.timelineIndex);
  const snapshot = useSimStore((s) => s.playbackSnapshot);

  if (!dataset || dataset.rows.length === 0) {
    return (
      <div className="component-detail-placeholder">
        <p>尚未导入实验数据。</p>
        <p className="hint">点击「📥 导入数据」选择 PDF / Excel / CSV 文件后，采集字段将显示在对应部件与仪表上。</p>
      </div>
    );
  }

  const rows = dataset.prepared.processedRows;
  const sourceRowIndex = snapshot?.sourceRowIndices[dataset.sourceId];
  const current = Math.max(0, Math.min(sourceRowIndex ?? timelineIndex, rows.length - 1));

  return (
    <div className="dataset-report">
      <div className="dataset-summary">
        <span>文件：<code>{dataset.sourceFile}</code></span>
        <span>{rows.length} 行 × {dataset.headers.length} 列</span>
        {dataset.timeColumn && <span>时间列：<code>{dataset.timeColumn}</code></span>}
        <span>交集帧：<code>{timelineIndex + 1}</code></span>
        <span>本源行：<code>{current + 1} / {rows.length}</code></span>
      </div>
      <div className="component-detail-table-wrap">
        <table className="import-data-table">
          <thead>
            <tr>
              {dataset.headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(Math.max(0, current - 2), current + 3).map((processed) => (
              <tr key={processed.rowIndex} className={processed.rowIndex === current ? 'current' : ''}>
                {dataset.headers.map((h) => (
                  <td key={h}>{processed.raw[h] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        显示当前回放帧附近的行（{Math.max(0, current - 2) + 1}~{Math.min(rows.length, current + 3)}）。顶部时间轴可播放 / 拖拽浏览全部数据。
      </p>
    </div>
  );
}

interface Props {
  compId: string | null;
  onClose: () => void;
}

const COMPONENT_LABELS: Record<string, { name: string; type: string }> = {
  'pv-array':     { name: '光伏阵列',   type: 'PV' },
  'combiner-box': { name: '汇流箱',     type: 'CB' },
  'grid':         { name: '电网',       type: 'GRID' },
  'grid-switch':  { name: '并网开关',   type: 'GS' },
  'inverter':     { name: '逆变器',     type: 'IV' },
  'battery':      { name: '蓄电池',     type: 'BAT' },
  'load':         { name: '室内用电',   type: 'LOAD' },
  'heat-pump':    { name: '热泵机组',   type: 'HP' },
  'tank':         { name: '水箱',       type: 'TANK' },
  'pump':         { name: '循环水泵',   type: 'PUMP' },
  'pcm':          { name: '相变材料',   type: 'PCM' },
  'air-terminal': { name: '末端风盘',   type: 'AT' },
  'solar-air-cooler': { name: '太阳能水冷风扇', type: 'SAC' },
  'power-meter':  { name: '功率检测器', type: 'PM' },
  'temp-sensor':  { name: '温度检测器', type: 'TS' },
};

const TYPE_COLOR: Record<string, string> = {
  PV: '#E63946',
  HP: '#F97316',
  PCM: '#0EA5E9',
};

function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? '#3B82F6';
}

export function ComponentDetail({ compId, onClose }: Props) {
  const [currentId, setCurrentId] = useState(compId);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (compId) setCurrentId(compId);
  }, [compId]);

  useEffect(() => {
    if (!compId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compId, onClose]);

  if (!compId || !currentId) return null;

  const comp = COMPONENT_LABELS[currentId];

  return (
    <div className="component-detail-overlay" onClick={onClose}>
      <div className="component-detail-modal" onClick={(e) => e.stopPropagation()}>
        <button className="component-detail-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="component-detail-body">
          <aside className="component-detail-sidebar">
            <h3>部件列表</h3>
            <ul>
              {Object.entries(COMPONENT_LABELS).map(([id, l]) => (
                <li
                  key={id}
                  className={id === currentId ? 'active' : ''}
                  onClick={() => setCurrentId(id)}
                >
                  <span className="dot" style={{ background: typeColor(l.type) }} />
                  <span>{l.name}</span>
                  <span className="id">#{id.slice(-4)}</span>
                </li>
              ))}
            </ul>
          </aside>
          <main className="component-detail-main">
            <div className="component-detail-header">
              <h2>{comp?.name ?? currentId}</h2>
              <span className="component-detail-id">{currentId}</span>
            </div>
            <div className="component-detail-section">
              <h4>当前状态</h4>
              <div className="component-detail-stats">
                <ComponentStats compId={currentId} />
              </div>
            </div>
            <div className="component-detail-section">
              <h4>数据报表</h4>
              <DatasetReport />
            </div>
            <div className="component-detail-actions">
              <button
                className="primary"
                onClick={() => setImportOpen(true)}
                title="导入实验数据（PDF / Excel / CSV 全量采集数据，驱动原理图各部件与仪表）"
              >
                📥 导入数据
              </button>
            </div>
          </main>
        </div>
        <ImportDataDialog
          compId={currentId}
          open={importOpen}
          onClose={() => setImportOpen(false)}
        />
      </div>
    </div>
  );
}

function ComponentStats({ compId }: { compId: string }) {
  // 订阅 store，让 stats 随滑块/开关变化实时更新
  const s = useSimStore();
  const hasDataSession = s.controlMode === 'replay' && s.playbackSnapshot != null;
  const available = (field: keyof typeof s.injectionFieldAvailability) =>
    !hasDataSession || s.injectionFieldAvailability[field] === true;
  const sampled = (field: keyof typeof s.injectionFieldAvailability, value: string) =>
    available(field) ? value : '—';
  const status = (field: keyof NonNullable<typeof s.playbackSnapshot>['statusAvailability'], yes: string, no: string) =>
    s.playbackSnapshot && s.playbackSnapshot.statusAvailability[field] !== true
      ? '数据未提供'
      : (s[field] ? yes : no);
  const currentConvention = useAnalysisStore((state) => state.batteryCurrentConvention);
  const stats: Array<{ label: string; value: string }> = [];

  switch (compId) {
    case 'pv-array':
      stats.push({ label: 'PV 功率', value: sampled('pv_power', s.pv_power.toFixed(2) + ' kW') });
      stats.push({ label: '阳光强度', value: sampled('pv_sun', (s.pv_sun * 100).toFixed(0) + '%') });
      stats.push({ label: '运行', value: status('pv_on', '✓', '✗') });
      break;
    case 'combiner-box':
      stats.push({ label: '连接', value: status('cb_connected', '已连接', '断开') });
      stats.push({ label: 'PV 输入', value: sampled('pv_power', Math.min(4, Math.ceil(s.pv_power / 1.5)) + ' 路') });
      break;
    case 'grid':
      stats.push({ label: '在线', value: status('grid_online', '✓', '✗') });
      stats.push({ label: '规格', value: 'AC 380V · 50Hz' });
      break;
    case 'grid-switch':
      stats.push({ label: '合闸', value: status('gs_on', '✓', '✗') });
      stats.push({ label: '闸状态', value: status('gs_on', '● 合闸', '● 分闸') });
      break;
    case 'inverter':
      stats.push({ label: 'IV 功率', value: sampled('pv_power', s.pv_power.toFixed(2) + ' kW') });
      stats.push({ label: '模式', value: deriveInverterMode(s) === 'dc-to-ac' ? 'DC→AC' : deriveInverterMode(s) === 'ac-to-dc' ? 'AC→DC' : 'IDLE' });
      break;
    case 'battery':
      {
        const batV = readCell(s, '电压(V)');
        const batA = readCell(s, '电流(A)');
        const batSoc = readCell(s, 'SOC(%)');
        const hasBms = s.injectionSources.some((source) => source.role === 'battery-bms');
        const soc = batSoc ?? (available('bat_soc') ? s.bat_soc : null);
        const direction = batA == null || currentConvention === 'unknown'
          ? 'unknown'
          : batA === 0 ? 'idle'
            : currentConvention === 'positive-charge'
              ? (batA > 0 ? 'charging' : 'discharging')
              : (batA > 0 ? 'discharging' : 'charging');
        const staticMode = deriveStaticBatteryMode(s.battery_power_kw);
        stats.push({ label: 'SOC', value: soc == null ? '—' : soc.toFixed(0) + '%' });
        stats.push({ label: '电压', value: batV != null ? batV.toFixed(1) + ' V' : '—' });
        stats.push({ label: '电流', value: batA != null ? batA.toFixed(1) + ' A' : '—' });
        stats.push({ label: '功率', value: hasBms ? '—（仅显示 BMS 电压/电流）' : (s.battery_power_kw >= 0 ? '+' : '') + s.battery_power_kw.toFixed(2) + ' kW' });
        stats.push({ label: '状态', value: batA != null
          ? (direction === 'charging' ? '充电' : direction === 'discharging' ? '放电' : direction === 'idle' ? '待机' : '方向待确认')
          : hasDataSession ? '数据不可用' : (staticMode === 'charging' ? '充电' : staticMode === 'discharging' ? '放电' : '待机') });
      }
      break;
    case 'load':
      stats.push({ label: '运行', value: status('load_on', '✓', '✗') });
      stats.push({ label: '负载功率', value: sampled('load_power_kw', s.load_power_kw.toFixed(2) + ' kW') });
      break;
    case 'heat-pump':
      stats.push({ label: '运行', value: status('hp_on', '✓', '✗') });
      stats.push({ label: '温度', value: sampled('hp_temp', s.hp_temp.toFixed(0) + '℃') });
      stats.push({ label: '功率', value: sampled('hp_power', s.hp_power.toFixed(1) + ' kW') });
      stats.push({ label: 'COP', value: '3.8' });
      break;
    case 'tank':
      stats.push({ label: '温度', value: sampled('tank_temp', s.tank_temp.toFixed(0) + '℃') });
      stats.push({ label: '水量', value: sampled('tank_volume', s.tank_volume.toFixed(0) + '%') });
      stats.push({ label: '流量', value: sampled('tank_flow', s.tank_flow.toFixed(1) + ' m³/h') });
      break;
    case 'pump':
      stats.push({ label: '运行', value: status('pump_on', '✓', '✗') });
      stats.push({ label: '流量', value: sampled('pump_flow', s.pump_flow.toFixed(1) + ' m³/h') });
      break;
    case 'pcm':
      {
        const pcmData = buildPcmInjectData(s);
        const t0 = readCell(s, PCM_COLUMNS['pcm-t0']);
        const t1 = readCell(s, PCM_COLUMNS['pcm-t1']);
        stats.push({
          label: `温度 (${s.pcm_temp_select})`,
          value: !available('pcm_temp') ? '—' : pcmData.liveTemp != null ? pcmData.liveTemp.toFixed(1) + '℃' : s.pcm_temp.toFixed(0) + '℃',
        });
        stats.push({ label: 'T0 表面', value: t0 != null ? t0.toFixed(1) + '℃' : '—' });
        stats.push({ label: 'T1 内部', value: t1 != null ? t1.toFixed(1) + '℃' : '—' });
        stats.push({ label: '切换', value: '单击部件' });
      }
      break;
    case 'air-terminal':
      stats.push({ label: '模式', value: s.playbackSnapshot?.statusAvailability.at_mode === false ? '数据未提供' : s.at_mode });
      stats.push({ label: '温度', value: sampled('at_temp', s.at_temp.toFixed(0) + '℃') });
      stats.push({ label: '风档', value: sampled('at_fan_speed', s.at_fan_speed + '/4') });
      break;
    case 'solar-air-cooler':
      stats.push({ label: '运行', value: s.sac_on ? '✓' : '✗' });
      stats.push({ label: '水位', value: s.sac_water_level.toFixed(0) + '%' });
      stats.push({ label: '水温', value: s.sac_water_temp.toFixed(0) + '℃' });
      stats.push({ label: '风速', value: s.sac_fan_speed.toFixed(2) });
      stats.push({ label: '出风温度', value: s.sac_on && s.sac_water_level > 10 ? s.sac_outlet_temp.toFixed(0) + '℃' : '—' });
      stats.push({ label: '供电', value: '逆变器输出侧并联' });
      break;
    case 'power-meter':
      stats.push({ label: 'PM 值', value: sampled('pv_power', s.pv_power.toFixed(2) + ' kW') });
      stats.push({ label: '三相电流', value: sampled('pv_power', (s.pv_power / 0.38 / 3).toFixed(2) + ' A') });
      break;
    case 'temp-sensor':
      stats.push({ label: 'TS 值', value: sampled('tank_temp', s.tank_temp.toFixed(0) + '℃') });
      stats.push({ label: '标签', value: '水箱温度' });
      break;
  }

  if (stats.length === 0) {
    return <div className="component-detail-empty">该部件暂无可显示状态</div>;
  }

  return (
    <div className="component-detail-stats-grid">
      {stats.map((stat, i) => (
        <div key={i} className="component-detail-stat">
          <span className="label">{stat.label}</span>
          <span className="value">{stat.value}</span>
        </div>
      ))}
    </div>
  );
}
