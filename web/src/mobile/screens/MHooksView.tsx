import { type ReactNode } from 'react';
import {
  MPill,
  MC,
  MONO,
} from '@/mobile/ui/kit';
import { MSettingsSurfaceCard as MCard, MSettingsSheet as MBottomSheet,
  MSettingsGroupLabel as MGroupLabel } from './MSettingsControls';
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

const ID_STYLE: React.CSSProperties = { font: `600 12.5px ${MONO}`, color: MC.ink, overflowWrap: 'anywhere' };
const META_STYLE: React.CSSProperties = { font: `400 12px ${MONO}`, color: MC.muted, marginTop: 3, overflowWrap: 'anywhere' };

// ── mount targets (plan §4.1): where the declaration actually installs once compiled ────────
function MountBadges({ targets }: { targets: MHookRow['mountsOn'] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {targets.map((t) => (
        <MPill key={t} tone="running">
          {t}
        </MPill>
      ))}
    </div>
  );
}

// ── one hook row — tapping it opens the read-only declaration sheet ─────────────
function HookRow({ row, L, onOpen }: { row: MHookRow; L: Vocab; onOpen: (key: string) => void }) {
  return (
    <MCard onClick={() => onOpen(row.key)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={ID_STYLE}>{row.id}</div>
          <div style={META_STYLE}>
            {row.event} · {row.source}
          </div>
        </div>
        <span style={{ flex: 'none' }}>
          <MPill tone={row.enabled ? 'done' : 'cancelled'}>{row.enabled ? L.stHookEnabled : L.stHookDisabled}</MPill>
        </span>
      </div>
      {(row.mountsOn.length > 0 || row.scriptMissing) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <MountBadges targets={row.mountsOn} />
          {/* A declared script that is not on disk fails silently at runtime (plan §4.5) — the only
              condition on this read-only surface that deserves an alarm colour. */}
          {row.scriptMissing && (
            <span style={{ marginLeft: 'auto', flex: 'none' }}>
              <MPill tone="failed">{L.hookScriptMissing}</MPill>
            </span>
          )}
        </div>
      )}
    </MCard>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <MGroupLabel>
        {L[GROUP_KEYS[group.key]]} · {group.rows.length}
      </MGroupLabel>
      {group.rows.map((row) => (
        <HookRow key={row.key} row={row} L={L} onOpen={onOpenHook} />
      ))}
    </div>
  );
}

// ── declaration sheet ───────────────────────────────────────────────────────────
function FieldRow({ label, children, divider = true }: { label: string; children: ReactNode; divider?: boolean }) {
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
      <span style={{ font: `500 13px ${MONO}`, color: MC.ink, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </div>
  );
}

/**
 * The declaration rows. Identity and semantics (event / run / order / mounts / applies / source) are
 * always shown — a gap there is real information. Optional declaration fields are shown only when the
 * entry actually declares them, so a sparse entry does not read as a column of dashes.
 */
function declarationRows(detail: MHookDetailVm, L: Vocab): { label: string; value: ReactNode }[] {
  const rows: { label: string; value: ReactNode }[] = [{ label: L.hookFieldEvent, value: detail.event }];

  if (detail.matcher?.kind === 'regex') rows.push({ label: L.hookFieldMatcher, value: detail.matcher.value });
  if (detail.matcher?.kind === 'filters') {
    rows.push({
      label: L.hookFieldFilters,
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
  if (detail.requiresTool !== null) rows.push({ label: L.hookFieldRequiresTool, value: detail.requiresTool });
  if (detail.result !== null) rows.push({ label: L.hookFieldResult, value: detail.result });
  if (detail.blocking !== null) {
    rows.push({
      label: L.hookFieldBlocking,
      value: `${detail.blocking.mode} · ${detail.blocking.ttlMin}${L.setUnitMin}`,
    });
  }

  rows.push({ label: L.hookFieldMountsOn, value: <MountBadges targets={detail.mountsOn} /> });
  rows.push({ label: L.hookFieldApplies, value: L[APPLIES_KEYS[detail.appliesAt]] });
  rows.push({ label: L.hookFieldSource, value: detail.source });
  if (detail.version !== null) rows.push({ label: L.hookFieldVersion, value: detail.version });
  if (detail.fileName !== null) rows.push({ label: L.hookFieldFile, value: detail.fileName });
  rows.push({ label: L.hookFieldOrder, value: String(detail.order) });

  return rows;
}

function DeclarationSheet({ row, L, onClose }: { row: MHookRow; L: Vocab; onClose: () => void }) {
  const rows = declarationRows(row.detail, L);
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 10px' }}>
        <span style={{ font: `700 15px ${MONO}`, color: MC.ink, minWidth: 0, overflowWrap: 'anywhere' }}>
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
          <FieldRow key={r.label} label={r.label} divider={i < rows.length - 1}>
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
  return <span style={{ font: `500 12px ${MONO}`, color: MC.muted }}>
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
        <div style={{ padding: '2px 4px', fontSize: 12, color: MC.muted, textAlign: 'right' }}>
          {L.setEditOnDesktop}
        </div>
      )}
      {sheetRow && <DeclarationSheet row={sheetRow} L={L} onClose={onCloseSheet} />}
    </>
  );
}
