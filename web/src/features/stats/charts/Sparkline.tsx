import { sparkPaths } from '../stats-vm';

const WIDTH = 150;

/** A trend line with a 12% wash under it; stretches to its container's width. */
export function Sparkline({ values, color, height = 30 }: { values: readonly (number | null)[]; color: string; height?: number }) {
  const { line, area } = sparkPaths(values, WIDTH, height);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {area ? <path d={area} fill={color} opacity={0.12} /> : null}
      {line ? <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}
