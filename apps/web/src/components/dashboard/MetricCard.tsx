interface Props {
  label: string;
  value: string;
  unit?: string;
  tone?: 'cyan' | 'blue' | 'yellow' | 'green' | 'orange' | 'purple';
}

export function MetricCard({ label, value, unit, tone = 'cyan' }: Props) {
  return (
    <article className="m3-metric-card" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>{unit && <em>{unit}</em>}
    </article>
  );
}
