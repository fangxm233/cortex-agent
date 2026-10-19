import { MDrillHeader, MScreen, MScrollBody, MGroup, MGroupLabel, MC, M_GUTTER, M_NUM } from '@/mobile/ui/kit';
import { fmt, useVocabOptional, type Vocab } from '@/i18n';
import type { MMemoryVm, MMemoryFileRow, MMemoryDirCard } from './m-memory-vm';

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
function Chevron({ open = false, color = MC.muted }: { open?: boolean; color?: string }) {
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

// Row text x: dividers start here, so they never run under the doc glyph.
const ROW_PAD_X = 14;
const FILE_TEXT_X = ROW_PAD_X + 12 + 9;
/** Files inside an opened dir sit one step in from the dir name. */
const NESTED_PAD_X = ROW_PAD_X + 14;

// A read-only, tappable file row (scheme L536-537): doc icon + filename + real rel time + a
// trailing chevron that signals it drills into the read-only file viewer.
// GAP: descriptor + `+N −M` / `草稿` badges are scheme mocks (no DTO field) → omitted.
function FileRow({ row, nested = false, onOpen }: { row: MMemoryFileRow; nested?: boolean; onOpen: (path: string) => void }) {
  return (
    <div
      role="button"
      onClick={() => onOpen(row.path)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: `10px ${ROW_PAD_X}px 10px ${nested ? NESTED_PAD_X : ROW_PAD_X}px`,
        minHeight: 44,
        boxSizing: 'border-box',
        cursor: 'pointer',
      }}
    >
      <DocIcon />
      <span style={{ fontSize: 14, color: MC.body, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.name}
      </span>
      <span style={{ marginLeft: 'auto', fontSize: 12, color: MC.muted, flex: 'none', ...M_NUM }}>
        {row.time}
      </span>
      <Chevron color={MC.muted} />
    </div>
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
  copy: Vocab;
  open: boolean;
  onToggle: (name: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <div data-memory-dir={dir.name}>
      <div
        role="button"
        aria-expanded={open}
        onClick={() => onToggle(dir.name)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: `9px ${ROW_PAD_X}px`,
          minHeight: 44,
          boxSizing: 'border-box',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: MC.ink, minWidth: 0, overflowWrap: 'anywhere' }}>{dir.name}/</span>
        <span style={{ fontSize: 13, color: MC.muted, marginLeft: 7, ...M_NUM }}>{dir.entryCount}</span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>
          <Chevron open={open} />
        </span>
      </div>
      {open &&
        (dir.entries.length === 0 ? (
          <div style={{ padding: `0 ${ROW_PAD_X}px 12px ${NESTED_PAD_X}px`, fontSize: 13, color: MC.muted }}>{copy.memEmptyDir}</div>
        ) : (
          <MGroup inset={NESTED_PAD_X + FILE_TEXT_X - ROW_PAD_X}>
            {dir.entries.map((row) => <FileRow key={row.path} row={row} nested onOpen={onOpen} />)}
          </MGroup>
        ))}
    </div>
  );
}

export function MMemoryView({
  vm,
  openDirs,
  onToggleDir,
  onBack,
  onOpenFile,
}: {
  vm: MMemoryVm;
  /** Names of the currently-expanded dir accordions (container-owned). */
  openDirs: ReadonlySet<string>;
  /** Toggle a dir accordion open/closed by name. */
  onToggleDir: (name: string) => void;
  onBack: () => void;
  /** Open a file's read-only viewer. `path` is the project-root-relative path (memory.file arg). */
  onOpenFile: (path: string) => void;
}) {
  const copy = useVocabOptional();
  const header = (
    <MDrillHeader
      onBack={onBack}
      trailing={
        <span style={{ fontSize: 13, color: MC.muted, ...M_NUM }}>
          {fmt(copy.memTreeCount, { n: vm.fileCount })}
        </span>
      }
    >
      <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>
        {copy.projectMemory}
      </div>
    </MDrillHeader>
  );
  return (
    <MScreen label="1j memory" header={header}>
      <MScrollBody gap={0} padding={`12px ${M_GUTTER}px 0`}>
        {vm.isEmpty ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.muted, fontSize: 13 }}>
            {copy.memEmpty}
          </div>
        ) : (
          <>
            {vm.core.length > 0 && (
              <section style={{ marginBottom: 18 }}>
                <MGroupLabel style={{ fontSize: 13 }}>{copy.memCore}</MGroupLabel>
                <MGroup inset={FILE_TEXT_X}>
                  {vm.core.map((row) => <FileRow key={row.path} row={row} onOpen={onOpenFile} />)}
                </MGroup>
              </section>
            )}
            <MGroup>
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
            </MGroup>
            <div style={{ fontSize: 12.5, color: MC.muted, padding: `12px ${ROW_PAD_X}px 0` }}>{copy.memFooter}</div>
          </>
        )}
      </MScrollBody>
    </MScreen>
  );
}
