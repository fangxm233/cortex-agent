import { useNavigate } from 'react-router-dom';
import type { SessionContextUsage } from '@cortex-agent/ui-contract';
import { ContextCompactFooter, ContextUsageDetails, type ContextCompactAction } from '@/features/session/composer/ContextUsageControl';
import { buildSessionIdRows } from '@/features/session/list/session-id';
import type { SessionStatsRow } from '@/features/session/list/session-stats';
import { MBackChevron, MBottomSheet, MC, MONO, M_NUM } from '@/mobile/ui/kit';
import { useEffect, useState, type ReactNode } from 'react';
import type { ModelOption, SelectionRootRow } from '@/features/session/list/selection-menu';
import type { SelectionSheetRow, SelectionSheetSection, SelectionSheetVM } from './m-chat-vm';
import type { MChatSelection, MChatSelectionView } from './m-chat-selection';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';
import { SelectionPane } from '@/design/SelectionPane';
import { useVocabOptional } from '@/i18n';
import { HEADER_BOTTOM_VAR } from './useHeaderClearance';

export function MoreMenu({ onClose, onSessionId, onSessionStats, metadataItems }: {
  onClose: () => void;
  onSessionId: () => void;
  /** Absent until the session has finished a run — there is nothing to total up before that. */
  onSessionStats?: () => void;
  metadataItems?: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const copy = useVocabOptional();
  // The header status line is one short glance and already ellipsised, so the desktop's second
  // segment does not fit there: on mobile the whole-session totals live behind this menu instead.
  const items = [
    { label: copy.wbSessionId, onTap: onSessionId },
    ...(onSessionStats ? [{ label: copy.wbSessionStats, onTap: onSessionStats }] : []),
  ];
  // A sibling of header/composer, outside the transcript's isolated scroller:
  // the menu can sample the route backdrop, not a blurred ancestor's flat fill.
  // It drops 8px under the floating header stack; z-index above chrome and below sheets.
  return (
    <><div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 5 }} /><div style={{ position: 'absolute', top: `calc(var(${HEADER_BOTTOM_VAR}) + 8px)`, right: 12, width: 148, background: 'var(--material-overlay-bg)', backdropFilter: MC.glassFilter, WebkitBackdropFilter: MC.glassFilter, border: '1px solid var(--panel-translucent-border)', borderRadius: 'var(--r-card)', boxShadow: 'var(--material-overlay-shadow)', overflow: 'hidden', zIndex: 6 }}>
      {metadataItems}
      {items.map((item, index) => <div key={item.label} onClick={item.onTap} style={{ padding: '11px 14px', fontSize: 13, color: MC.ink, borderBottom: index < items.length - 1 ? '1px solid var(--proto-line-2)' : undefined, cursor: 'pointer' }}>{item.label}</div>)}
    </div></>
  );
}

interface SessionIdRowProps {
  row: { key: string; label: string; value: string };
  copied: boolean;
  onCopy: () => void;
}

function SessionIdRow({ row, copied, onCopy }: SessionIdRowProps): JSX.Element {
  const copy = useVocabOptional();
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: MC.muted, padding: '0 2px 5px' }}>{row.label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--material-inset-bg)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-control)', padding: '10px 12px' }}>
        <span style={{ flex: 1, minWidth: 0, font: `500 12px ${MONO}`, color: MC.ink, wordBreak: 'break-all', userSelect: 'all' }}>{row.value}</span>
        <span role="button" onClick={onCopy} style={{ flex: 'none', fontSize: 13, fontWeight: 600, color: copied ? MC.done : MC.sub, border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-chip)', padding: '4px 10px', cursor: row.value === '—' ? 'default' : 'pointer', opacity: row.value === '—' ? 0.4 : 1 }}>{copied ? copy.cmCopied : copy.cmCopy}</span>
      </div>
    </div>
  );
}

export function SessionIdSheet({ sessionId, backendUuid, onClose }: {
  sessionId: string | null | undefined;
  backendUuid: string | null | undefined;
  onClose: () => void;
}): JSX.Element {
  const copy = useVocabOptional();
  const rows = buildSessionIdRows({ sessionId, backendUuid, sessionIdLabel: copy.wbSessionId, backendUuidLabel: copy.wbBackendUuid });
  const { copiedKey, copy: writeCopy } = useClipboardFeedback<string>();
  const doCopy = (key: string, value: string): void => {
    if (value !== '—') void writeCopy(value, key);
  };
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ fontSize: 17, fontWeight: 650, color: MC.ink, padding: '0 2px 12px' }}>{copy.wbSessionId}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>{rows.map((row) => <SessionIdRow key={row.key} row={row} copied={copiedKey === row.key} onCopy={() => doCopy(row.key, row.value)} />)}</div>
    </MBottomSheet>
  );
}

/** A clean session's workspace: what the mode means, and the folder to copy. */
export function CleanWorkspaceSheet({ dir, onClose }: { dir: string; onClose: () => void }): JSX.Element {
  const copy = useVocabOptional();
  const { copiedKey, copy: writeCopy } = useClipboardFeedback<'workspace'>();
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-clean-workspace-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 650, color: MC.ink, padding: '0 2px 4px' }}>{copy.wbClean}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: MC.muted, padding: '0 2px 12px' }}>{copy.wbCleanHint}</div>
        <SessionIdRow row={{ key: 'workspace', label: copy.wbCleanWorkspace, value: dir }} copied={copiedKey === 'workspace'}
          onCopy={() => void writeCopy(dir, 'workspace')} />
      </div>
    </MBottomSheet>
  );
}

export function SessionStatsSheet({ rows, onClose }: {
  rows: SessionStatsRow[];
  onClose: () => void;
}): JSX.Element {
  const copy = useVocabOptional();
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-session-stats-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 650, color: MC.ink, padding: '0 2px 12px' }}>{copy.wbSessionStats}</div>
        <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '4px 13px' }}>
          {rows.map((row, index) => (
            <div
              key={row.key}
              data-session-stats-row={row.key}
              style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0', borderBottom: index < rows.length - 1 ? `1px solid ${MC.hairline}` : undefined }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: MC.body }}>{row.label}</span>
              <span style={{ flex: 'none', fontSize: 14, fontWeight: 600, color: MC.ink, ...M_NUM }}>{row.value}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: MC.muted, padding: '10px 2px 0' }}>{copy.wbSessionStatsHint}</div>
      </div>
    </MBottomSheet>
  );
}

export function ContextUsageSheet({ usage, compactAction, onClose }: {
  usage: SessionContextUsage | null;
  compactAction?: ContextCompactAction;
  onClose: () => void;
}): JSX.Element {
  const L = useVocabOptional();
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-context-usage-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 650, color: MC.ink, padding: '0 2px 10px' }}>{L.chatCtxTitle}</div>
        <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '12px 13px' }}><ContextUsageDetails usage={usage} /></div>
        {compactAction ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px 0' }}><ContextCompactFooter action={compactAction} /></div> : null}
      </div>
    </MBottomSheet>
  );
}

function FavoriteStar({ option, onToggle }: {
  option: ModelOption;
  onToggle: (option: ModelOption) => void;
}): JSX.Element {
  const copy = useVocabOptional();
  return <button
    type="button" data-model-star={option.id}
    aria-label={option.favorite ? copy.chatFavoriteRemove : copy.chatFavoriteAdd}
    aria-pressed={option.favorite}
    onClick={(event) => { event.stopPropagation(); onToggle(option); }}
    style={{ flex: 'none', background: 'transparent', border: 0, padding: '8px', fontSize: 18, color: option.favorite ? MC.ink : MC.muted, cursor: 'pointer' }}
  >{option.favorite ? '★' : '☆'}</button>;
}

function SelectionRow({ row, last, onPick, onToggleFavorite }: {
  row: SelectionSheetRow;
  last: boolean;
  onPick: (row: SelectionSheetRow) => void;
  onToggleFavorite?: (option: ModelOption) => void;
}): JSX.Element {
  const copy = useVocabOptional();
  return (
    <div
      data-selection-row={row.id}
      data-disabled={row.disabled ? 'true' : undefined}
      onClick={() => { if (!row.disabled) onPick(row); }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: last ? undefined : '1px solid var(--proto-line-soft)', cursor: 'pointer', opacity: row.disabled ? 0.45 : 1 }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 15, fontWeight: row.current ? 600 : 500, color: MC.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
          {row.current && <span style={{ fontSize: 12, fontWeight: 500, padding: '1px 7px', borderRadius: 6, background: 'var(--proto-gray)', color: MC.muted, flex: 'none' }}>{copy.chatSelectionCurrent}</span>}
        </div>
        {row.sub && <div style={{ fontSize: 12.5, color: MC.muted, marginTop: 3, overflowWrap: 'anywhere' }}>{row.sub}</div>}
      </div>
      {row.current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.ink, flex: 'none' }}>✓</span>}
      {row.modelOption && onToggleFavorite && <FavoriteStar option={row.modelOption} onToggle={onToggleFavorite} />}
    </div>
  );
}

/** A collapsed model, thinking or route row showing the concrete selection. */
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
      <span style={{ fontSize: 14, color: MC.body, flex: 'none' }}>{row.label}</span>
      <span style={{ marginLeft: 'auto', minWidth: 0, fontSize: 14, fontWeight: 600, color: MC.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.value}</span>
      <span style={{ fontSize: 15, color: MC.muted, flex: 'none' }}>›</span>
    </div>
  );
}

function SheetCard({ children }: { children: ReactNode }): JSX.Element {
  return <div style={{ background: 'transparent', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', overflow: 'hidden' }}>{children}</div>;
}

function SheetNote({ text }: { text: string }): JSX.Element {
  return <div style={{ fontSize: 12.5, color: MC.muted, lineHeight: 1.5, padding: '7px 4px 0' }}>{text}</div>;
}

function SectionRows({ section, onPick, onToggleFavorite }: {
  section: SelectionSheetSection;
} & Pick<SelectionSheetProps, 'onPick' | 'onToggleFavorite'>): JSX.Element {
  return (
    <SheetCard>
      {section.rows.map((row, index) => (
        <div key={row.id}>
          {row.group && row.group !== section.rows[index - 1]?.group && (
            <div data-selection-group={row.group} style={{ padding: '10px 13px 2px', fontSize: 12, fontWeight: 600, color: MC.muted }}>{row.group}</div>
          )}
          <SelectionRow row={row} last={index === section.rows.length - 1} onPick={onPick} onToggleFavorite={onToggleFavorite} />
        </div>
      ))}
    </SheetCard>
  );
}

/** Favorites close the sheet; model/thinking/route picks return to its root. Stars stay in place. */
interface SelectionSheetProps {
  vm: SelectionSheetVM;
  /** PI is configured but has not reported its models yet. */
  pending?: boolean;
  onClose: () => void;
  onPick: (row: SelectionSheetRow) => void;
  onToggleFavorite?: (option: ModelOption) => void;
}

function SelectionSection({ section, pending, back, onPick, onToggleFavorite }: {
  section: SelectionSheetSection;
  back: () => void;
} & Pick<SelectionSheetProps, 'pending' | 'onPick' | 'onToggleFavorite'>): JSX.Element {
  const copy = useVocabOptional();
  return (
    <>
      <div onClick={back} data-selection-back="true" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 12px', cursor: 'pointer' }}>
        <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', color: MC.ink, margin: '0 -2px 0 -4px' }}><MBackChevron /></span>
        <span style={{ fontSize: 17, fontWeight: 650, color: MC.ink }}>{section.title}</span>
      </div>
      <SectionRows section={section} onPick={(row) => { back(); onPick(row); }} onToggleFavorite={onToggleFavorite} />
      {section.key === 'model' && pending && <SheetNote text={copy.wbModelsPending} />}
    </>
  );
}

function ModelSettingsRow({ onClose }: { onClose: () => void }): JSX.Element {
  const copy = useVocabOptional();
  const navigate = useNavigate();
  return <SheetCard>
    <button type="button" data-selection-settings
      onClick={() => { onClose(); navigate('/m/settings/models'); }}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
        minHeight: 44, padding: '12px 13px', border: 0, background: 'transparent',
        font: 'inherit', fontSize: 14, color: MC.ink, textAlign: 'left', cursor: 'pointer' }}>
      <span>{copy.wbModelSettings}</span><span aria-hidden="true" style={{ color: MC.muted }}>›</span>
    </button>
  </SheetCard>;
}

function SelectionRoot({ vm, onClose, onPick, setPane }: SelectionSheetProps & {
  setPane: (pane: SelectionRootRow['key']) => void;
}): JSX.Element {
  const copy = useVocabOptional();
  const pick = (row: SelectionSheetRow): void => { onClose(); onPick(row); };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}><span style={{ fontSize: 17, fontWeight: 650, color: MC.ink }}>{copy.chatFavoritesTitle}</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        {vm.sections[0]?.rows.length
          ? <SectionRows section={vm.sections[0]} onPick={pick} />
          : <SheetNote text={copy.chatFavoritesEmpty} />}
        <SheetCard>
          {vm.rootRows.map((row, index) => (
            <SelectionDrillRow key={row.key} row={row} last={index === vm.rootRows.length - 1} onOpen={() => setPane(row.key)} />
          ))}
        </SheetCard>
        <ModelSettingsRow onClose={onClose} />
      </div>
    </>
  );
}

export function SelectionSheet(props: SelectionSheetProps): JSX.Element {
  const [pane, setPane] = useState<SelectionRootRow['key'] | null>(null);
  const section = pane ? props.vm.sections.find((entry) => entry.key === pane) ?? null : null;
  const back = (): void => setPane(null);
  return (
    <MBottomSheet onClose={props.onClose} onBack={section ? back : undefined} animateHeight>
      <SelectionPane pane={pane ?? 'root'}>
        {section
          ? <SelectionSection section={section} back={back} {...props} />
          : <SelectionRoot {...props} setPane={setPane} />}
      </SelectionPane>
    </MBottomSheet>
  );
}

/** The environment sheet: which agent — which prompt, tools, skills and rules — this conversation
 *  runs in. One flat list, so a tap is the whole visit and the sheet closes behind it. Drawn only
 *  where there is something to choose between; the screen decides that, the same `> 1 agent` rule
 *  the desktop chip obeys.
 *  Its rows come from `buildAgentSheet` — the desktop menu's arithmetic. */
export function AgentSheet({ rows, onClose, onPick }: {
  rows: SelectionSheetRow[];
  onClose: () => void;
  onPick: (row: SelectionSheetRow) => void;
}): JSX.Element {
  const title = useVocabOptional().wbAgent;
  return (
    <MBottomSheet onClose={onClose}>
      <div data-mobile-agent-sheet="true">
        <div style={{ fontSize: 17, fontWeight: 650, color: MC.ink, padding: '0 2px 12px' }}>{title}</div>
        <SheetCard>
          {rows.map((row, index) => (
            <SelectionRow
              key={row.id}
              row={row}
              last={index === rows.length - 1}
              onPick={(picked) => { onClose(); onPick(picked); }}
            />
          ))}
        </SheetCard>
      </div>
    </MBottomSheet>
  );
}

/** The engine and environment sheets, open while the shared selection controller says so. */
export function SelectionSheets({ selection, view, onPick }: {
  selection: MChatSelection;
  view: MChatSelectionView;
  onPick: (row: SelectionSheetRow) => void;
}): JSX.Element {
  return (
    <>
      {view.sheet && (
        <SelectionSheet vm={view.sheet.vm} pending={view.sheet.pending} onClose={() => selection.setOpen(false)} onPick={onPick} onToggleFavorite={selection.toggleFavorite} />
      )}
      {view.agentRows && <AgentSheet rows={view.agentRows} onClose={() => selection.setAgentOpen(false)} onPick={onPick} />}
    </>
  );
}
