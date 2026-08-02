import { LINE_COLORS, type Cable } from '../data/cables';

interface CableControlItemProps {
  cable: Cable;
  isSelected: boolean;
  onSelect: (id: string | null) => void;
}

export function CableControlItem({
  cable,
  isSelected,
  onSelect,
}: CableControlItemProps) {
  const kindLabel = cable.kind === 'power'
    ? '电力线'
    : cable.kind === 'refrigerant'
    ? '制冷剂'
    : '水线';
  const dotColor = LINE_COLORS[cable.kind];

  return (
    <div
      className={`cable-row ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(isSelected ? null : cable.id)}
      title={`${kindLabel} #${cable.id.slice(-4)}`}
    >
      <span className="cable-dot" style={{ background: dotColor }} />
      <span className="cable-row-label">
        {kindLabel} <span className="cable-row-id">#{cable.id.slice(-4)}</span>
      </span>
      <span className="cable-row-chevron">{isSelected ? '▼' : '▶'}</span>
    </div>
  );
}
