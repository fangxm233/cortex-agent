// Pure view-model for the mobile 项目记忆 file viewer (/m/memory/file). Read-only. Maps the real
// `memory.file({ projectId, path })` DTO into a header basename + metaline. Only real DTO fields
// (path / sizeBytes / modifiedAt) are surfaced — the desktop 7b viewer's git diff/blame is deliberately
// not shown here (mobile is a clean read). Kept dependency-light so it is unit-testable without a DOM.
import { relTimeZh } from '@/mobile/ui/format';

/** Last path segment (the filename), e.g. `experiments/EXP-001.md` → `EXP-001.md`. */
export function fileBasename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Human-readable byte size: `< 1 KB` as `N B`, else `N.M KB` / `N.M MB` (1 decimal, trimmed). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${trim1(kb)} KB`;
  return `${trim1(kb / 1024)} MB`;
}

function trim1(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
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
