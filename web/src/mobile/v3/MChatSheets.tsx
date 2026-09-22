// input:  React, mobile presentation props, shared view models
// output: MChatSheets
// pos:    Mobile glass sheets and Escape-dismissible More menu
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { ContextCompactFooter, ContextUsageDetails, contextUsageTitle, type ContextCompactAction } from '@/features/workbench/ContextUsageControl';
import { buildSessionIdRows } from '@/features/workbench/session-id';
import type { SessionStatsRow } from '@/features/workbench/session-stats';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import { useEffect, useState, type ReactNode } from 'react';
import type { SelectionRootRow } from '@/features/workbench/selection-menu';
import type { SelectionSheetRow, SelectionSheetSection, SelectionSheetVM } from './m-chat-vm';
import type { BrowserSheetItem, CommissionSheetItem, MChatCopy } from './MChatView.types';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';

export function MoreMenu({ copy, onClose, onSessionId, onSessionStats }: {
  copy: MChatCopy;
  onClose: () => void;
  onSessionId: () => void;
  /** Absent until the session has finished a run — there is nothing to total up before that. */
  onSessionStats?: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // The header status line is ~10px mono and already ellipsised, so the desktop's second segment
  // does not fit there: on mobile the whole-session totals live behind this menu instead.
  const items = [
    { label: copy.menuSessionId, onTap: onSessionId },
    ...(onSessionStats ? [{ label: copy.menuSessionStats, onTap: onSessionStats }] : []),
  ];
  // A sibling of header/composer, outside the transcript's isolated scroller:
  // the menu can sample the route backdrop, not a blurred ancestor's flat fill.
  // Keep its anchor and z-index above chrome and below sheets.
  return (
    <><div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} /><div style={{ position: 'absolute', top: 'calc(68px + env(safe-area-inset-top))', right: 12, width: 148, background: 'var(--material-overlay-bg)', backdropFilter: MC.glassFilter, WebkitBackdropFilter: MC.glassFilter, border: '1px solid var(--panel-translucent-border)', borderRadius: 'var(--r-card)', boxShadow: 'var(--material-overlay-shadow)', overflow: 'hidden', zIndex: 6 }}>
      {items.map((item, index) => <div key={item.label} onClick={item.onTap} style={{ padding: '11px 14px', fontSize: 13, color: MC.ink, borderBottom: index < items.length - 1 ? '1px solid var(--proto-line-2)' : undefined, cursor: 'pointer' }}>{item.label}</div>)}
    </div></>
  );
}

interface SessionIdRowProps {
  row: { key: string; label: string; value: string };
  copy: MChatCopy;
  copied: boolean;
  onCopy: () => void;
}

function SessionIdRow({ row, copy, copied, onCopy }: SessionIdRowProps): JSX.Element {
  return (
    <div>
      <div style={{ font: `600 11px ${MONO}`, letterSpacing: '.05em', color: MC.muted, padding: '0 2px 5px' }}>{row.label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--material-inset-bg)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-control)', padding: '10px 12px' }}>
        <span style={{ flex: 1, minWidth: 0, font: `500 12px ${MONO}`, color: MC.ink, wordBreak: 'break-all', userSelect: 'all' }}>{row.value}</span>
        <span role="button" onClick={onCopy} style={{ flex: 'none', font: `600 11px ${MONO}`, color: copied ? MC.run : MC.muted, border: `1px solid ${copied ? MC.runBorder : 'var(--proto-line-3)'}`, borderRadius: 'var(--r-chip)', padding: '4px 9px', cursor: row.value === '—' ? 'default' : 'pointer', opacity: row.value === '—' ? 0.4 : 1 }}>{copied ? copy.copied : copy.copy}</span>
      </div>
    </div>
  );
}

export function SessionIdSheet({ copy, cortexId, backendUuid, onClose }: {
  copy: MChatCopy;
  cortexId: string | null | undefined;
  backendUuid: string | null | undefined;
  onClose: () => void;
}): JSX.Element {
  const rows = buildSessionIdRows({ cortexId, backendUuid, cortexIdLabel: copy.cortexIdLabel, backendUuidLabel: copy.backendUuidLabel });
  const { copiedKey, copy: writeCopy } = useClipboardFeedback<string>();
  const doCopy = (key: string, value: string): void => {
    if (value !== '—') void writeCopy(value, key);
  };
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 12px' }}>{copy.sessionIdTitle}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>{rows.map((row) => <SessionIdRow key={row.key} row={row} copy={copy} copied={copiedKey === row.key} onCopy={() => doCopy(row.key, row.value)} />)}</div>
    </MBottomSheet>
  );
}

export function SessionStatsSheet({ copy, rows, onClose }: {
  copy: MChatCopy;
  rows: SessionStatsRow[];
  onClose: () => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-session-stats-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 12px' }}>{copy.sessionStatsTitle}</div>
        <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '4px 13px' }}>
          {rows.map((row, index) => (
            <div
              key={row.key}
              data-session-stats-row={row.key}
              style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0', borderBottom: index < rows.length - 1 ? `1px solid ${MC.hairline}` : undefined }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: MC.body }}>{row.label}</span>
              <span style={{ flex: 'none', font: `600 12.5px ${MONO}`, color: MC.ink }}>{row.value}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.55, color: MC.muted, padding: '10px 2px 0' }}>{copy.sessionStatsHint}</div>
      </div>
    </MBottomSheet>
  );
}

export function ContextUsageSheet({ usage, lang, compactAction, onClose }: {
  usage: SessionContextUsage | null;
  lang: 'en' | 'zh';
  compactAction?: ContextCompactAction;
  onClose: () => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-context-usage-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 10px' }}>{contextUsageTitle(lang)}</div>
        <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '12px 13px' }}><ContextUsageDetails usage={usage} lang={lang} /></div>
        {compactAction ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px 0' }}><ContextCompactFooter action={compactAction} lang={lang} /></div> : null}
      </div>
    </MBottomSheet>
  );
}

function SelectionRow({ row, last, copy, onPick }: {
  row: SelectionSheetRow;
  last: boolean;
  copy: MChatCopy;
  onPick: (row: SelectionSheetRow) => void;
}): JSX.Element {
  return (
    <div
      data-selection-row={row.id}
      data-disabled={row.disabled ? 'true' : undefined}
      onClick={() => { if (!row.disabled) onPick(row); }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer', opacity: row.disabled ? 0.45 : 1 }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ font: `600 13px ${MONO}`, color: MC.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
          {row.current && <span style={{ fontSize: 11, fontWeight: 600, padding: '1.5px 7px', borderRadius: 'var(--r-pill)', background: MC.runBg, color: MC.run, flex: 'none' }}>{copy.profileCurrent}</span>}
        </div>
        {row.sub && <div style={{ font: `400 11px ${MONO}`, color: MC.muted, marginTop: 3, overflowWrap: 'anywhere' }}>{row.sub}</div>}
      </div>
      {row.current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
    </div>
  );
}

/** A collapsed override on the root: what it is, the value in force, and a dot when that value is
 *  the session's own choice rather than the profile's. */
function SelectionDrillRow({ row, last, onOpen }: {
  row: SelectionRootRow;
  last: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div
      data-selection-pane={row.key}
      onClick={onOpen}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer' }}
    >
      <span style={{ fontSize: 13, color: MC.body, flex: 'none' }}>{row.label}</span>
      <span style={{ marginLeft: 'auto', minWidth: 0, font: `600 12.5px ${MONO}`, color: row.overridden ? MC.run : MC.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.value}</span>
      {row.overridden && <span style={{ fontSize: 13, color: MC.run, flex: 'none' }}>•</span>}
      <span style={{ fontSize: 15, color: MC.muted, flex: 'none' }}>›</span>
    </div>
  );
}

function SheetCard({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>{children}</div>;
}

function SheetNote({ text }: { text: string }): JSX.Element {
  return <div style={{ font: `400 11px ${MONO}`, color: MC.muted, lineHeight: 1.5, padding: '7px 4px 0' }}>{text}</div>;
}

function SectionRows({ section, copy, onPick }: {
  section: SelectionSheetSection;
  copy: MChatCopy;
  onPick: (row: SelectionSheetRow) => void;
}): JSX.Element {
  return (
    <SheetCard>
      {section.rows.map((row, index) => (
        <SelectionRow key={row.id} row={row} last={index === section.rows.length - 1} copy={copy} onPick={onPick} />
      ))}
    </SheetCard>
  );
}

/** The engine sheet, two levels deep. The ROOT is the profile list plus one collapsed row per
 *  override; each of those opens a pane of its own. A pick inside a pane returns to the root with
 *  the sheet still open — model and level are usually chosen together — while naming a profile is
 *  the wholesale move (it drops the overrides too), so that one closes the sheet.
 *  The rows come from `buildSelectionSheet`, which is the desktop menu's arithmetic; this file only
 *  draws them. */
export function SelectionSheet({ vm, copy, pending, onClose, onPick }: {
  vm: SelectionSheetVM;
  copy: MChatCopy;
  /** PI is configured but has not reported its models yet. */
  pending?: boolean;
  onClose: () => void;
  onPick: (row: SelectionSheetRow) => void;
}): JSX.Element {
  const [pane, setPane] = useState<SelectionRootRow['key'] | null>(null);
  const section = pane ? vm.sections.find((entry) => entry.key === pane) ?? null : null;
  const back = (): void => setPane(null);

  return (
    <MBottomSheet onClose={onClose} onBack={section ? back : undefined}>
      {section ? (
        <>
          <div onClick={back} data-selection-back="true" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 12px', cursor: 'pointer' }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: MC.run }}>‹</span>
            <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{section.title}</span>
          </div>
          <SectionRows section={section} copy={copy} onPick={(row) => { back(); onPick(row); }} />
          {section.key === 'model' && pending && <SheetNote text={copy.selectionPending} />}
          {section.footer && <SheetNote text={section.footer} />}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}><span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{copy.profileTitle}</span><span style={{ marginLeft: 'auto', font: `400 11px ${MONO}`, color: MC.muted }}>{copy.profileSubtitle}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {vm.sections[0] && (
              <div>
                <SectionRows section={vm.sections[0]} copy={copy} onPick={(row) => { onClose(); onPick(row); }} />
                {vm.sections[0].footer && <SheetNote text={vm.sections[0].footer} />}
              </div>
            )}
            <SheetCard>
              {vm.rootRows.map((row, index) => (
                <SelectionDrillRow key={row.key} row={row} last={index === vm.rootRows.length - 1 && !vm.clearRow} onOpen={() => setPane(row.key)} />
              ))}
              {vm.clearRow && (
                <SelectionRow row={vm.clearRow} last copy={copy} onPick={(row) => { onClose(); onPick(row); }} />
              )}
            </SheetCard>
          </div>
          <SheetNote text={copy.profileFooter} />
        </>
      )}
    </MBottomSheet>
  );
}

/** The environment sheet: which agent — which prompt, tools, skills and rules — this conversation
 *  runs in. One flat list, so a tap is the whole visit and the sheet closes behind it. Drawn only
 *  where there is something to choose between; the screen decides that, the same `> 1 agent` rule
 *  the desktop chip obeys.
 *  Its rows come from `buildAgentSheet` — the desktop menu's arithmetic. */
export function AgentSheet({ rows, title, copy, onClose, onPick }: {
  rows: SelectionSheetRow[];
  title: string;
  copy: MChatCopy;
  onClose: () => void;
  onPick: (row: SelectionSheetRow) => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-agent-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em', padding: '0 2px 12px' }}>{title}</div>
        <SheetCard>
          {rows.map((row, index) => (
            <SelectionRow
              key={row.id}
              row={row}
              last={index === rows.length - 1}
              copy={copy}
              onPick={(picked) => { onClose(); onPick(picked); }}
            />
          ))}
        </SheetCard>
      </div>
    </MBottomSheet>
  );
}

/** One creation-time option (a browser device, a commission). `attr` is the test/selector hook, kept
 *  per-surface so the two sheets stay individually addressable while sharing this markup. */
function OptionRow({ item, attr, last, current, onPick }: {
  item: { value: string | null; label: string; sub: string };
  attr: 'data-device' | 'data-commission-option';
  last: boolean;
  current: string | null;
  onPick: (value: string | null) => void;
}): JSX.Element {
  return (
    <div {...{ [attr]: item.value ?? '__off__' }} onClick={() => onPick(item.value)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer' }}>
      <div style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}><span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{item.label}</span>{item.sub && <div style={{ font: `400 11px ${MONO}`, color: MC.muted, marginTop: 3 }}>{item.sub}</div>}</div>
      {item.value === current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
    </div>
  );
}

function OptionSheet({ items, attr, title, current, onClose, onPick }: {
  items: Array<{ value: string | null; label: string; sub: string }>;
  attr: 'data-device' | 'data-commission-option';
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (value: string | null) => void;
}): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}><span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{title}</span></div>
      <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>{items.map((item, index) => <OptionRow key={item.value ?? '__off__'} item={item} attr={attr} last={index === items.length - 1} current={current} onPick={onPick} />)}</div>
    </MBottomSheet>
  );
}

export function BrowserSheet({ items, title, current, onClose, onPick }: {
  items: BrowserSheetItem[];
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (device: string | null) => void;
}): JSX.Element {
  return (
    <OptionSheet
      items={items.map((i) => ({ value: i.device, label: i.label, sub: i.sub }))}
      attr="data-device" title={title} current={current} onClose={onClose} onPick={onPick}
    />
  );
}

export function CommissionSheet({ items, title, current, onClose, onPick }: {
  items: CommissionSheetItem[];
  title: string;
  current: string | null;
  onClose: () => void;
  onPick: (value: string | null) => void;
}): JSX.Element {
  return (
    <OptionSheet
      items={items} attr="data-commission-option"
      title={title} current={current} onClose={onClose} onPick={onPick}
    />
  );
}
