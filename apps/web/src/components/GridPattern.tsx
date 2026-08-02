interface GridPatternProps {
  size: number;
  width: number;
  height: number;
}

export function GridPattern({ size, width, height }: GridPatternProps) {
  const cols = Math.floor(width / size);
  const rows = Math.floor(height / size);

  return (
    <g pointerEvents="none">
      <defs>
        <pattern id="grid-pattern" width={size} height={size} patternUnits="userSpaceOnUse">
          <path
            d={`M ${size} 0 L 0 0 0 ${size}`}
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="0.5"
          />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#grid-pattern)" />
      {/* 主轴线（每 100px 加粗） */}
      {Array.from({ length: cols + 1 }, (_, i) => i * 100).map((x) => (
        <line key={`v${x}`} x1={x} y1={0} x2={x} y2={height} stroke="#cbd5e1" strokeWidth="0.8" />
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => i * 100).map((y) => (
        <line key={`h${y}`} x1={0} y1={y} x2={width} y2={y} stroke="#cbd5e1" strokeWidth="0.8" />
      ))}
    </g>
  );
}