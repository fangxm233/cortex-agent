// input:  memory-file metadata, wall-clock time, and shared byte formatting
// output: mobile memory filename and honest metadata line
// pos:    Pure view model for the mobile memory-file reader
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Only real path/size/modified fields are surfaced; desktop-only diff/blame data stays omitted.
import { relTimeZh } from '@/mobile/ui/format';
import { formatBytes as formatSharedBytes } from '@/lib/format';

/** Last path segment (the filename), e.g. `experiments/EXP-001.md` → `EXP-001.md`. */
export function fileBasename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Human-readable byte size: `< 1 KB` as `N B`, else `N.M KB` / `N.M MB` (1 decimal, trimmed). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '';
  return formatSharedBytes(n, { fractionDigits: 1, trimTrailingZeros: true, maxUnit: 'MB' });
}

/** Header metaline: `path · rel-time · size`, empty segments dropped (honest — never fabricated). */
export function fileMetaLine(
  file: { path: string; modifiedAt?: string | null; sizeBytes?: number | null } | null | undefined,
  now: number = Date.now(),
): string {
  if (!file) return '';
  const time = relTimeZh(file.modifiedAt, now);
  const size = formatBytes(file.sizeBytes);
  return [file.path, time, size].filter((s) => s && s.length > 0).join(' · ');
}
