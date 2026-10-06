/**
 * A duration in its two largest units — `45s`, `1m 30s`, `6h 12m`, `2d 7h` — dropping a zero second
 * unit (`1h`, `3d`). Two units is enough to read at a glance for everything Cortex reports: a wait,
 * an interval, an execution's elapsed time, a process uptime. Negative or non-finite input reads
 * `unknown`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return pair(m, 'm', s % 60, 's');
  const h = Math.floor(m / 60);
  if (h < 24) return pair(h, 'h', m % 60, 'm');
  return pair(Math.floor(h / 24), 'd', h % 24, 'h');
}

function pair(major: number, majorUnit: string, minor: number, minorUnit: string): string {
  return minor ? `${major}${majorUnit} ${minor}${minorUnit}` : `${major}${majorUnit}`;
}
