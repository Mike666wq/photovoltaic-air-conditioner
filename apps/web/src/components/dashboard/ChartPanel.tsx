import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function ChartPanel({ title, subtitle, children, className = '' }: Props) {
  return (
    <section className={`m3-chart-panel ${className}`}>
      <header className="m3-chart-panel__header">
        <h2>{title}</h2>
        {subtitle && <span title={subtitle}>{subtitle}</span>}
      </header>
      <div className="m3-chart-panel__body">{children}</div>
    </section>
  );
}
