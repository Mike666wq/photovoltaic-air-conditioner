import { LINE_COLORS, type Cable } from '../data/cables';
import { useSimStore } from '../store/simulation';

interface Props {
  cable: Cable;
}

const idMap: Record<string, string> = {
  'pv-array': 'PV 阵列',
  'combiner-box': '汇流箱',
  'grid': '电网',
  'grid-switch': '并网开关',
  'inverter': '逆变器',
  'battery': '蓄电池',
  'load': '负载',
  'heat-pump': '热泵',
  'tank': '水箱',
  'pump': '水泵',
  'pcm': '相变材料',
  'air-terminal': '末端',
  'power-meter': '功率表',
  'temp-sensor': '温度传感器',
};

const sideMap: Record<string, string> = {
  top: '顶',
  bottom: '底',
  left: '左',
  right: '右',
};

function humanizeAnchor(anchorId: string): string {
  if (!anchorId) return '浮动端点';
  if (anchorId.startsWith('cable:')) {
    return anchorId.endsWith('.from') ? '线缆 起点' : '线缆 终点';
  }
  const m = anchorId.match(/^(.+)\.(top|bottom|left|right)$/);
  if (!m) return anchorId;
  const compLabel = idMap[m[1]] ?? m[1];
  const sideLabel = sideMap[m[2]] ?? m[2];
  return `${compLabel} · ${sideLabel}`;
}

export function CableControlDetail({ cable }: Props) {
  const animEnabled = cable.animationEnabled ?? true;
  const dir = cable.direction ?? 'forward';
  const kindLabel = cable.kind === 'power'
    ? '电力线'
    : cable.kind === 'refrigerant'
    ? '制冷剂'
    : '水线';
  const dotColor = LINE_COLORS[cable.kind];

  const setCableAnimation = useSimStore((s) => s.setCableAnimation);
  const toggleCableDirection = useSimStore((s) => s.toggleCableDirection);
  const meters = useSimStore((s) => s.meters);
  const attachedMeters = meters.filter((m) => m.cableId === cable.id);

  const firstSeg = cable.segments[0];
  const lastSeg = cable.segments[cable.segments.length - 1];
  const fromLabel = humanizeAnchor(firstSeg?.fromAnchorId ?? '');
  const toLabel = humanizeAnchor(lastSeg?.toAnchorId ?? '');

  return (
    <div className="cable-detail">
      <div className="cable-detail-header">
        <span className="cable-dot" style={{ background: dotColor }} />
        <span className="cable-detail-title">
          {kindLabel} <span className="cable-row-id">#{cable.id.slice(-4)}</span>
        </span>
        <span className="cable-detail-count">
          {cable.segments.length} 段
        </span>
      </div>
      <div className="cable-detail-actions">
        <button
          type="button"
          className={`cable-action-btn ${animEnabled ? 'on' : 'off'}`}
          onClick={() => setCableAnimation(cable.id, !animEnabled)}
        >
          动画 {animEnabled ? '开' : '关'}
        </button>
        <button
          type="button"
          className="cable-action-btn direction"
          onClick={() => toggleCableDirection(cable.id)}
        >
          方向 {dir === 'forward' ? '→' : '←'}
        </button>
      </div>
      <div className="cable-detail-info">
        <div className="cable-info-row">
          <span className="cable-info-label">起点</span>
          <span className="cable-info-value">{fromLabel}</span>
        </div>
        <div className="cable-info-row">
          <span className="cable-info-label">终点</span>
          <span className="cable-info-value">{toLabel}</span>
        </div>
      </div>
      {attachedMeters.length > 0 && (
        <div className="cable-detail-meters">
          <h4>挂载仪表</h4>
          {attachedMeters.map((meter) => (
            <div key={meter.id} className="cable-meter-row">
              {meter.type === 'power-meter' ? '功率检测器' : '温度检测器'} #{meter.id.slice(-4)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
