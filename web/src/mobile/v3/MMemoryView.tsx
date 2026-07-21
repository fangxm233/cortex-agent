// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1j L523-554)
//
// 1j 项目记忆 — the current project's memory tree, drilled from the project page (1e→1j). NON-Tab drill
// page: the shell hides the Tab bar for /m/memory. READ-ONLY (viewing only; no writes). Pure
// presentational view (render-testable without tRPC providers); the container (MMemoryScreen) binds
// `memory.tree` + navigation and owns the open-file route.
//
// Files ARE now openable: every top-level (核心) file row and every dir-entry row taps through to the
// read-only file viewer (/m/memory/file). The four memory dirs (experiments/knowledge/patterns/
// decisions) render as ACCORDIONS — tap the header to expand/collapse the real file list (from the DTO
// `entries`, no fabrication); collapsed shows just the header + real count.
//
// HONEST GAPS (never fabricated — no DTO field backs them): the scheme's `+42 −7` line-diff badges, the
// `草稿` status badge, and per-file descriptors (`规则 · 边界 · mission`, `Phase 2 · M2.3`) are design
// mocks → OMITTED. Per-file git diff/blame lives on the desktop 7b viewer, not here.
import { type ReactNode } from 'react';
import { MDrillHeader, MScrollBody, MCard, MC, MONO } from '@/mobile/ui/kit';
import type { MMemoryVm, MMemoryFileRow, MMemoryDirCard } from './m-memory-vm';

export interface MMemoryCopy {
  title: string;
  /** `核心` — the top-level files group label. */
  core: string;
  /** Header unit: `memory/ · N {filesUnit}` (zh `个文件` / en `files`). */
  filesUnit: string;
  /** Muted label shown when an expanded dir has no entries (zh `空` / en `Empty`). */
  emptyDir: string;
  footer: string;
  empty: string;
}

// The scheme's file-doc svg (1j L536): 12px, 1.5 stroke, muted (var(--proto-muted-2)).
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

// A right-pointing chevron; rotates 90° down when `open` (accordion header affordance).
function Chevron({ open = false, color = MC.faint }: { open?: boolean; color?: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      style={{ flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' }}
    >
      <path d="M3.5 1.5 7 5 3.5 8.5" />
    </svg>
  );
}

// A read-only, tappable file row (scheme L536-537): doc icon + mono filename + real rel time + a
// trailing chevron that signals it drills into the read-only file viewer.
// GAP: descriptor + `+N −M` / `草稿` badges are scheme mocks (no DTO field) → omitted.
function FileRow({ row, last, onOpen }: { row: MMemoryFileRow; last: boolean; onOpen: (path: string) => void }) {
  return (
    <div
      role="button"
      onClick={() => onOpen(row.path)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '10px 13px',
        borderBottom: last ? undefined : '1px solid var(--proto-alt)',
        cursor: 'pointer',
      }}
    >
      <DocIcon />
      <span style={{ font: `500 12px ${MONO}`, color: MC.body, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.name}
      </span>
      <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint, flex: 'none' }}>
        {row.time}
      </span>
      <Chevron color={MC.faint} />
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

// A memory dir accordion (scheme L540-543 repurposed): the header is a tap toggle (label + count +
// rotating chevron); expanded reveals the real file rows; collapsed shows just the header. The
// open-state is CONTROLLED by the container (SSR-testable in both states, house style — cf. MTasksView).
function DirAccordion({
  dir,
  copy,
  open,
  onToggle,
  onOpen,
}: {
  dir: MMemoryDirCard;
  copy: MMemoryCopy;
  open: boolean;
  onToggle: (name: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <Card>
      <div
        role="button"
        aria-expanded={open}
        onClick={() => onToggle(dir.name)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '9px 13px',
          borderBottom: open ? '1px solid var(--proto-line-2)' : undefined,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{dir.name}/</span>
        <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint, marginLeft: 7 }}>{dir.entryCount}</span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>
          <Chevron open={open} />
        </span>
      </div>
      {open &&
        (dir.entries.length === 0 ? (
          <div style={{ padding: '10px 13px', font: `400 11px ${MONO}`, color: MC.faint }}>{copy.emptyDir}</div>
        ) : (
          dir.entries.map((row, i) => (
            <FileRow key={row.path} row={row} last={i === dir.entries.length - 1} onOpen={onOpen} />
          ))
        ))}
    </Card>
  );
}

export function MMemoryView({
  vm,
  copy,
  openDirs,
  onToggleDir,
  onBack,
  onOpenFile,
}: {
  vm: MMemoryVm;
  copy: MMemoryCopy;
  /** Names of the currently-expanded dir accordions (container-owned). */
  openDirs: ReadonlySet<string>;
  /** Toggle a dir accordion open/closed by name. */
  onToggleDir: (name: string) => void;
  onBack: () => void;
  /** Open a file's read-only viewer. `path` is the project-root-relative path (memory.file arg). */
  onOpenFile: (path: string) => void;
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
                <div style={{ display: 'flex', alignItems: 'center', padding: '9px 13px', borderBottom: '1px solid var(--proto-line-2)' }}>
                  <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{copy.core}</span>
                </div>
                {vm.core.map((row, i) => (
                  <FileRow key={row.path} row={row} last={i === vm.core.length - 1} onOpen={onOpenFile} />
                ))}
              </Card>
            )}
            {vm.dirs.map((d: MMemoryDirCard) => (
              <DirAccordion
                key={d.name}
                dir={d}
                copy={copy}
                open={openDirs.has(d.name)}
                onToggle={onToggleDir}
                onOpen={onOpenFile}
              />
            ))}
            <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '0 4px' }}>{copy.footer}</div>
          </>
        )}
      </MScrollBody>
    </>
  );
}
