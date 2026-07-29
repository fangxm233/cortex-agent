// input:  hooks view model, copy, and the selected row
// output: namespace-grouped read-only hook list with a declaration sheet
// pos:    Presentational mobile hooks view
// >>> If I am updated, update my header comment and CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (drill page under 1l 设置)
//
// The mobile mirror of the hook registry (plan §6). Read-only by design: editing a declaration lives
// on desktop, so this surface carries no control that could write — the sheet renders exactly what
// `hooks.list` reports. Pure presentational (render-testable without tRPC providers); MHooksScreen
// binds the query, the selected row and navigation.
import { type ReactNode } from 'react';
import {
  MDrillHeader,
  MScrollBody,
  MCard,
  MPill,
  MGroupLabel,
  MBottomSheet,
  MC,
  MONO,
} from '@/mobile/ui/kit';
import type { MHooksVm, MHookGroup, MHookRow, MHookGroupKey, MHookDetailVm } from './m-hooks-vm';

export interface MHooksCopy {
  title: string;
  /** Header trailing readout: `14/17 <enabledWord>`. */
  enabledWord: string;
  /** Footer unit: `17 <countUnit>`. */
  countUnit: string;
  group: Record<MHookGroupKey, string>;
  enabled: string;
  disabled: string;
  scriptMissing: string;
  empty: string;
  editDesktop: string;
  /** Placeholder for a declared-but-absent value. */
  none: string;
  secondUnit: string;
  minuteUnit: string;
  field: {
    event: string;
    matcher: string;
    filters: string;
    script: string;
    command: string;
    run: string;
    timeout: string;
    backends: string;
    requiresTool: string;
    result: string;
    blocking: string;
    source: string;
    version: string;
    fileName: string;
    order: string;
    mountsOn: string;
    appliesAt: string;
    template: string;
    phase: string;
  };
  applies: Record<MHookDetailVm['appliesAt'], string>;
  sheetFooter: string;
}

const ID_STYLE: React.CSSProperties = { font: `600 12.5px ${MONO}`, color: MC.ink, overflowWrap: 'anywhere' };
const META_STYLE: React.CSSProperties = { font: `400 9.5px ${MONO}`, color: MC.muted, marginTop: 3, overflowWrap: 'anywhere' };

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
function HookRow({ row, copy, onOpen }: { row: MHookRow; copy: MHooksCopy; onOpen: (key: string) => void }) {
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
          <MPill tone={row.enabled ? 'done' : 'cancelled'}>{row.enabled ? copy.enabled : copy.disabled}</MPill>
        </span>
      </div>
      {(row.mountsOn.length > 0 || row.scriptMissing) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <MountBadges targets={row.mountsOn} />
          {/* A declared script that is not on disk fails silently at runtime (plan §4.5) — the only
              condition on this read-only surface that deserves an alarm colour. */}
          {row.scriptMissing && (
            <span style={{ marginLeft: 'auto', flex: 'none' }}>
              <MPill tone="failed">{copy.scriptMissing}</MPill>
            </span>
          )}
        </div>
      )}
    </MCard>
  );
}

function GroupSection({
  group,
  copy,
  onOpenHook,
}: {
  group: MHookGroup;
  copy: MHooksCopy;
  onOpenHook: (key: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <MGroupLabel>
        {copy.group[group.key]} · {group.rows.length}
      </MGroupLabel>
      {group.rows.map((row) => (
        <HookRow key={row.key} row={row} copy={copy} onOpen={onOpenHook} />
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
      <span style={{ fontSize: 11, color: MC.muted, flex: 'none', width: 92 }}>{label}</span>
      <span style={{ font: `500 10.5px ${MONO}`, color: MC.ink, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </div>
  );
}

/**
 * The declaration rows. Identity and semantics (event / run / order / mounts / applies / source) are
 * always shown — a gap there is real information. Optional declaration fields are shown only when the
 * entry actually declares them, so a template-scoped hook does not read as a column of dashes.
 */
function declarationRows(detail: MHookDetailVm, copy: MHooksCopy): { label: string; value: ReactNode }[] {
  const rows: { label: string; value: ReactNode }[] = [{ label: copy.field.event, value: detail.event }];

  if (detail.matcher?.kind === 'regex') rows.push({ label: copy.field.matcher, value: detail.matcher.value });
  if (detail.matcher?.kind === 'filters') {
    rows.push({
      label: copy.field.filters,
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

  if (detail.run.kind === 'none') rows.push({ label: copy.field.run, value: copy.none });
  else {
    rows.push({
      label: detail.run.kind === 'script' ? copy.field.script : copy.field.command,
      value: (
        <>
          {detail.run.value}
          {detail.run.missing && (
            <span style={{ marginLeft: 6 }}>
              <MPill tone="failed">{copy.scriptMissing}</MPill>
            </span>
          )}
        </>
      ),
    });
  }
  if (detail.timeoutSec !== null) {
    rows.push({ label: copy.field.timeout, value: `${detail.timeoutSec}${copy.secondUnit}` });
  }

  if (detail.backends !== null) rows.push({ label: copy.field.backends, value: detail.backends.join(', ') });
  if (detail.requiresTool !== null) rows.push({ label: copy.field.requiresTool, value: detail.requiresTool });
  if (detail.result !== null) rows.push({ label: copy.field.result, value: detail.result });
  if (detail.blocking !== null) {
    rows.push({
      label: copy.field.blocking,
      value: `${detail.blocking.mode} · ${detail.blocking.ttlMin}${copy.minuteUnit}`,
    });
  }

  rows.push({ label: copy.field.mountsOn, value: <MountBadges targets={detail.mountsOn} /> });
  rows.push({ label: copy.field.appliesAt, value: copy.applies[detail.appliesAt] });
  rows.push({ label: copy.field.source, value: detail.source });
  if (detail.version !== null) rows.push({ label: copy.field.version, value: detail.version });
  if (detail.fileName !== null) rows.push({ label: copy.field.fileName, value: detail.fileName });
  if (detail.template !== null) rows.push({ label: copy.field.template, value: detail.template });
  if (detail.phase !== null) rows.push({ label: copy.field.phase, value: detail.phase });
  rows.push({ label: copy.field.order, value: String(detail.order) });

  return rows;
}

function DeclarationSheet({ row, copy, onClose }: { row: MHookRow; copy: MHooksCopy; onClose: () => void }) {
  const rows = declarationRows(row.detail, copy);
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 10px' }}>
        <span style={{ font: `700 15px ${MONO}`, color: MC.ink, minWidth: 0, overflowWrap: 'anywhere' }}>
          {row.id}
        </span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>
          <MPill tone={row.enabled ? 'done' : 'cancelled'}>{row.enabled ? copy.enabled : copy.disabled}</MPill>
        </span>
      </div>
      <div
        style={{
          background: 'var(--proto-card)',
          border: `1px solid ${MC.hairline}`,
          borderRadius: 13,
          overflow: 'hidden',
        }}
      >
        {rows.map((r, i) => (
          <FieldRow key={r.label} label={r.label} divider={i < rows.length - 1}>
            {r.value}
          </FieldRow>
        ))}
      </div>
      <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '9px 4px 0' }}>{copy.sheetFooter}</div>
    </MBottomSheet>
  );
}

export function MHooksView({
  vm,
  copy,
  sheetRow,
  onBack,
  onOpenHook,
  onCloseSheet,
}: {
  vm: MHooksVm;
  copy: MHooksCopy;
  /** The row whose declaration sheet is open; null while the list is plain. */
  sheetRow: MHookRow | null;
  onBack: () => void;
  onOpenHook: (key: string) => void;
  onCloseSheet: () => void;
}) {
  return (
    <>
      <MDrillHeader
        onBack={onBack}
        trailing={
          <span style={{ font: `500 10px ${MONO}`, color: MC.muted }}>
            {vm.enabledCount}/{vm.total} {copy.enabledWord}
          </span>
        }
      >
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>{copy.title}</div>
      </MDrillHeader>
      <MScrollBody gap={14}>
        {vm.groups.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: MC.faint, fontSize: 13 }}>{copy.empty}</div>
        )}
        {vm.groups.map((group) => (
          <GroupSection key={group.key} group={group} copy={copy} onOpenHook={onOpenHook} />
        ))}
        {vm.groups.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '2px 4px',
              font: `400 9.5px ${MONO}`,
              color: MC.faint,
            }}
          >
            <span>
              {vm.total} {copy.countUnit}
            </span>
            <span style={{ marginLeft: 'auto', color: MC.muted }}>{copy.editDesktop}</span>
          </div>
        )}
      </MScrollBody>
      {sheetRow && <DeclarationSheet row={sheetRow} copy={copy} onClose={onCloseSheet} />}
    </>
  );
}
