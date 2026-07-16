// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1j L523-554)
//
// 1j 项目记忆 — the current project's memory tree, drilled from the project page (1e→1j). NON-Tab drill
// page: the shell hides the Tab bar for /m/memory. READ-ONLY. Pure presentational view (render-testable
// without tRPC providers); the container (MMemoryScreen) binds `memory.tree` + navigation.
//
// HONEST GAPS (never fabricated — no DTO field backs them): the scheme's `+42 −7` line-diff badges, the
// `草稿` status badge, and per-file descriptors (`规则 · 边界 · mission`, `Phase 2 · M2.3`) are design
// mocks → OMITTED. MemoryDirEntry carries only name + entryCount (no nested file list) → the scheme's
// representative dir rows (EXP-023/EXP-022) can't be enumerated without fabrication → OMITTED; each dir
// card shows its header + an inert `查看全部 N 个 ›` row (no deeper mobile route — the desktop memory
// viewer owns per-file browsing). File rows are inert (read-only), honoring the read-only footer.
import { type ReactNode } from 'react';
import { MDrillHeader, MScrollBody, MCard, MC, MONO } from '@/mobile/ui/kit';
import type { MMemoryVm, MMemoryFileRow, MMemoryDirCard } from './m-memory-vm';

export interface MMemoryCopy {
  title: string;
  /** `核心` — the top-level files group label. */
  core: string;
  /** Header unit: `memory/ · N {filesUnit}` (zh `个文件` / en `files`). */
  filesUnit: string;
  /** Inert dir footer row: `{viewAllPrefix} N {viewAllSuffix} ›` (zh 查看全部/个 · en View all/''). */
  viewAllPrefix: string;
  viewAllSuffix: string;
  footer: string;
  empty: string;
}

// The scheme's file-doc svg (1j L536): 12px, 1.5 stroke, muted (#8A93A2).
function DocIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke={MC.muted}
      strokeWidth="1.5"
      style={{ flex: 'none' }}
    >
      <path d="M3 1.5h5.5L11.5 4v8.5h-8.5z" />
      <path d="M8.5 1.5V4H11" />
    </svg>
  );
}

// Card section header (scheme L535/L540): 12/650 label + optional faint mono count badge.
function CardHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '9px 13px', borderBottom: '1px solid #EFF1F5' }}>
      <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{label}</span>
      {count != null && (
        <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint, marginLeft: 7 }}>{count}</span>
      )}
    </div>
  );
}

// A read-only top-level file row (scheme L536-537): doc icon + mono filename + real rel time.
// GAP: descriptor + `+N −M` / `草稿` badges are scheme mocks (no DTO field) → omitted.
function FileRow({ row, last }: { row: MMemoryFileRow; last: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '10px 13px',
        borderBottom: last ? undefined : '1px solid #F7F8FA',
      }}
    >
      <DocIcon />
      <span style={{ font: `500 12px ${MONO}`, color: MC.body }}>{row.name}</span>
      <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint, flex: 'none' }}>
        {row.time}
      </span>
    </div>
  );
}

// Inert `查看全部 N 个 ›` row (scheme L543): no deeper mobile route → not tappable (honest). The count is
// real; per-file browsing lives on the desktop memory viewer.
function ViewAllRow({ n, copy }: { n: number; copy: MMemoryCopy }) {
  const suffix = copy.viewAllSuffix ? ` ${copy.viewAllSuffix}` : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '10px 13px' }}>
      <span style={{ font: `400 10px ${MONO}`, color: MC.run }}>
        {copy.viewAllPrefix} {n}
        {suffix} ›
      </span>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <MCard tone="default" padding={0} style={{ overflow: 'hidden' }}>
      {children}
    </MCard>
  );
}

export function MMemoryView({
  vm,
  copy,
  onBack,
}: {
  vm: MMemoryVm;
  copy: MMemoryCopy;
  onBack: () => void;
}) {
  return (
    <>
      <MDrillHeader
        onBack={onBack}
        trailing={
          <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint }}>
            memory/ · {vm.fileCount} {copy.filesUnit}
          </span>
        }
      >
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
          {copy.title}
        </div>
      </MDrillHeader>
      <MScrollBody gap={10}>
        {vm.isEmpty ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>
            {copy.empty}
          </div>
        ) : (
          <>
            {vm.core.length > 0 && (
              <Card>
                <CardHeader label={copy.core} />
                {vm.core.map((row, i) => (
                  <FileRow key={row.name} row={row} last={i === vm.core.length - 1} />
                ))}
              </Card>
            )}
            {vm.dirs.map((d: MMemoryDirCard) => (
              <Card key={d.name}>
                <CardHeader label={`${d.name}/`} count={d.entryCount} />
                <ViewAllRow n={d.entryCount} copy={copy} />
              </Card>
            ))}
            <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '0 4px' }}>{copy.footer}</div>
          </>
        )}
      </MScrollBody>
    </>
  );
}
