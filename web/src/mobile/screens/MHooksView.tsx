import { type ReactNode } from 'react';
import {
  MPill,
  MC,
  MONO,
} from '@/mobile/ui/kit';
import { MSET_INSET, MSettingsSection, MSettingsSheet as MBottomSheet } from './MSettingsControls';
import { useVocab, type Vocab } from '@/i18n';
import type { MHooksVm, MHookGroup, MHookRow, MHookGroupKey, MHookDetailVm } from './m-hooks-vm';

const GROUP_KEYS: Record<MHookGroupKey, keyof Vocab> = {
  agent: 'hookGroupAgent', cc: 'hookGroupCc', pi: 'hookGroupPi', cortex: 'hookGroupCortex', other: 'hookGroupOther',
};
const APPLIES_KEYS: Record<MHookDetailVm['appliesAt'], keyof Vocab> = {
  'next-agent': 'hookAppliesNextAgent', 'server-restart': 'hookAppliesRestart',
};
/** Placeholder for a declared-but-absent value. */
const NONE = '—';

const ID_STYLE: React.CSSProperties = { display: 'block', font: `600 12.5px ${MONO}`, overflowWrap: 'anywhere' };
const META_STYLE: React.CSSProperties = { display: 'block', fontSize: 12.5, color: MC.muted, marginTop: 3, overflowWrap: 'anywhere' };
const ROW_STYLE: React.CSSProperties = {
  width: '100%', minHeight: 44, border: 0, background: 'transparent', padding: `11px ${MSET_INSET}px`,
  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', cursor: 'pointer',
};

// ── mount targets (plan §4.1): where the declaration actually installs once compiled ────────
// Quiet gray tags: a mount target is a fact about the hook, not a running state.
function MountBadges({ targets }: { targets: MHookRow['mountsOn'] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {targets.map((t) => (
        <span key={t} style={{ fontSize: 12, fontWeight: 500, color: MC.sub, background: 'var(--proto-gray)', padding: '1px 7px', borderRadius: 6 }}>
          {t}
        </span>
      ))}
    </div>
  );
}

// Enabled is the default, so a row only speaks up when it deviates: a disabled hook greys out and
// says so; a declared script that is not on disk fails silently at runtime (plan §4.5) — the only
// condition on this read-only surface that deserves an alarm colour.
function HookState({ row, L }: { row: MHookRow; L: Vocab }) {
  if (row.scriptMissing) {
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', fontSize: 12, color: MC.fail }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: MC.fail }} />{L.hookScriptMissing}
    </span>;
  }
  return row.enabled ? null : <span style={{ fontSize: 12, color: MC.muted, flex: 'none' }}>{L.stHookDisabled}</span>;
}

// ── one hook row — tapping it opens the read-only declaration sheet ─────────────
function HookRow({ row, L, onOpen }: { row: MHookRow; L: Vocab; onOpen: (key: string) => void }) {
  const source = row.source === 'builtin' ? L.hkSourceBuiltin : L.hkSourceUser;
  return (
    <button type="button" data-hook-row={row.key} onClick={() => onOpen(row.key)} style={ROW_STYLE}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ ...ID_STYLE, color: row.enabled ? MC.ink : MC.muted }}>{row.id}</span>
        <span style={META_STYLE}>
          <span style={{ fontFamily: MONO, fontSize: 12 }}>{row.event}</span>
          {' · '}{[source, ...row.mountsOn].join(' · ')}
        </span>
      </span>
      <HookState row={row} L={L} />
      <span aria-hidden="true" style={{ color: MC.faint, fontSize: 15, flex: 'none' }}>›</span>
    </button>
  );
}

function GroupSection({
  group,
  L,
  onOpenHook,
}: {
  group: MHookGroup;
  L: Vocab;
  onOpenHook: (key: string) => void;
}) {
  return (
    <MSettingsSection title={`${L[GROUP_KEYS[group.key]]} · ${group.rows.length}`}>
      {group.rows.map((row) => (
        <HookRow key={row.key} row={row} L={L} onOpen={onOpenHook} />
      ))}
    </MSettingsSection>
  );
}

// ── declaration sheet ───────────────────────────────────────────────────────────
function FieldRow({ label, children, code = false, divider = true }: { label: string; children: ReactNode; code?: boolean; divider?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '9px 13px',
        borderBottom: divider ? `1px solid ${MC.divider}` : undefined,
      }}
    >
      <span style={{ fontSize: 13, color: MC.muted, flex: '0 1 92px' }}>{label}</span>
      <span style={{ ...(code ? { font: `500 12.5px ${MONO}` } : { fontSize: 13.5 }), color: MC.ink, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </div>
  );
}

interface DeclarationRow {
  label: string;
  value: ReactNode;
  /** Code — an event name, a pattern, a command, a path — takes the code face; words do not. */
  code?: boolean;
}

/**
 * The declaration rows. Identity and semantics (event / run / order / mounts / applies / source) are
 * always shown — a gap there is real information. Optional declaration fields are shown only when the
 * entry actually declares them, so a sparse entry does not read as a column of dashes.
 */
function declarationRows(detail: MHookDetailVm, L: Vocab): DeclarationRow[] {
  const rows: DeclarationRow[] = [{ label: L.hookFieldEvent, value: detail.event, code: true }];

  if (detail.matcher?.kind === 'regex') rows.push({ label: L.hookFieldMatcher, value: detail.matcher.value, code: true });
  if (detail.matcher?.kind === 'filters') {
    rows.push({
      label: L.hookFieldFilters,
      code: true,
      value: (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {detail.matcher.entries.map((e) => (
            <span key={e.key}>
              {e.key} = {e.value}
            </span>
          ))}
        </span>
      ),
    });
  }

  if (detail.run.kind === 'none') rows.push({ label: L.hookFieldRun, value: NONE });
  else {
    rows.push({
      label: detail.run.kind === 'script' ? L.hookFieldScript : L.hookFieldCommand,
      code: true,
      value: (
        <>
          {detail.run.value}
          {detail.run.missing && (
            <span style={{ marginLeft: 6 }}>
              <MPill tone="failed">{L.hookScriptMissing}</MPill>
            </span>
          )}
        </>
      ),
    });
  }
  if (detail.timeoutSec !== null) {
    rows.push({ label: L.hookFieldTimeout, value: `${detail.timeoutSec}${L.timeUnitS}` });
  }

  if (detail.backends !== null) rows.push({ label: L.hookFieldBackends, value: detail.backends.join(', ') });
  if (detail.requiresTool !== null) rows.push({ label: L.hookFieldRequiresTool, value: detail.requiresTool, code: true });
  if (detail.result !== null) rows.push({ label: L.hookFieldResult, value: detail.result });
  if (detail.blocking !== null) {
    rows.push({
      label: L.hookFieldBlocking,
      value: `${detail.blocking.mode} · ${detail.blocking.ttlMin}${L.setUnitMin}`,
    });
  }

  rows.push({ label: L.hookFieldMountsOn, value: <MountBadges targets={detail.mountsOn} /> });
  rows.push({ label: L.hookFieldApplies, value: L[APPLIES_KEYS[detail.appliesAt]] });
  rows.push({ label: L.hookFieldSource, value: detail.source === 'builtin' ? L.hkSourceBuiltin : L.hkSourceUser });
  if (detail.version !== null) rows.push({ label: L.hookFieldVersion, value: detail.version });
  if (detail.fileName !== null) rows.push({ label: L.hookFieldFile, value: detail.fileName, code: true });
  rows.push({ label: L.hookFieldOrder, value: String(detail.order) });

  return rows;
}

function DeclarationSheet({ row, L, onClose }: { row: MHookRow; L: Vocab; onClose: () => void }) {
  const rows = declarationRows(row.detail, L);
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 10px' }}>
        <span style={{ font: `600 15px ${MONO}`, color: MC.ink, minWidth: 0, overflowWrap: 'anywhere' }}>
          {row.id}
        </span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>
          <MPill tone={row.enabled ? 'done' : 'cancelled'}>{row.enabled ? L.stHookEnabled : L.stHookDisabled}</MPill>
        </span>
      </div>
      <div
        style={{
          background: 'transparent',
          border: `1px solid ${MC.hairline}`,
          borderRadius: 'var(--r-card)',
          overflow: 'hidden',
        }}
      >
        {rows.map((r, i) => (
          <FieldRow key={r.label} label={r.label} code={r.code} divider={i < rows.length - 1}>
            {r.value}
          </FieldRow>
        ))}
      </div>
    </MBottomSheet>
  );
}

/** Header count beside the page title: enabled declarations out of all of them. */
export function MHooksCount({ vm }: { vm: MHooksVm }) {
  const L = useVocab();
  return <span style={{ fontSize: 13, color: MC.muted, fontVariantNumeric: 'tabular-nums' }}>
    {vm.enabledCount}/{vm.total} {L.hookEnabledWord}
  </span>;
}

/** The loaded hooks list; the page frame and its loading / error states belong to the screen. */
export function MHooksView({
  vm,
  sheetRow,
  onOpenHook,
  onCloseSheet,
}: {
  vm: MHooksVm;
  /** The row whose declaration sheet is open; null while the list is plain. */
  sheetRow: MHookRow | null;
  onOpenHook: (key: string) => void;
  onCloseSheet: () => void;
}) {
  const L = useVocab();
  return (
    <>
      {vm.groups.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>{L.hookEmpty}</div>
      )}
      {vm.groups.map((group) => (
        <GroupSection key={group.key} group={group} L={L} onOpenHook={onOpenHook} />
      ))}
      {vm.groups.length > 0 && (
        <div style={{ padding: `0 ${MSET_INSET}px`, fontSize: 12, color: MC.muted, textAlign: 'right' }}>
          {L.setEditOnDesktop}
        </div>
      )}
      {sheetRow && <DeclarationSheet row={sheetRow} L={L} onClose={onCloseSheet} />}
    </>
  );
}
