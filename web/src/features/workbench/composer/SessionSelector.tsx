import { useRef, useState, type RefObject } from 'react';
import { useVocab } from '@/i18n';
import { agentChipParts, hasAgentChoice, selectionChipParts } from '@/features/session/list/selection-menu';
import type { SessionSelection } from '@/features/session/composer/useSessionSelection';
import { AgentMenu } from './AgentMenu';
import { MENU_FOCUS, MONO, useDismissMenu } from '@/design/MenuChrome';
import { Popover } from '@/design/Popover';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';
import { canRevealServerPath, revealPath } from '@/lib/files';
import { SelectionMenu } from './SelectionMenu';
import { AgentGlyph, CleanGlyph, ModelGlyph, quietChipStyle } from './composer-chip';

// The composer's chips, drawn off the one headless `useSessionSelection`: the engine chip and, to
// its left, the environment chip. The rules behind both live in that hook. Both are the toolbar's
// filled quiet chip (`composer-chip`), and the model chip reads "model · sub". Left of them sits the
// clean-mode chip: a toggle on a draft, a read-only chip that shows the workspace afterwards.

function SelectionTrigger({ selection, hover, triggerRef }: {
  selection: SessionSelection; hover: boolean; triggerRef: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const L = useVocab();
  const parts = selectionChipParts(selection.effective);
  return <button type="button" data-chip="selection" ref={triggerRef} className={MENU_FOCUS}
    aria-expanded={selection.open} title={`${L.wbModel} · ${selection.effective.model}`}
    onClick={(event) => { event.stopPropagation(); selection.setOpen(!selection.open); }}
    style={{ ...quietChipStyle(hover || selection.open), maxWidth: 280 }}>
    <ModelGlyph />
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parts.main}</span>
    {parts.sub ? <span style={{ flex: 'none', whiteSpace: 'nowrap' }}>· {parts.sub}</span> : null}
  </button>;
}

function SessionSelectionMenu({ selection, close }: { selection: SessionSelection; close: () => void }): JSX.Element {
  const backToRoot = () => selection.setPane('root');
  return <SelectionMenu
    onClose={close}
    favorites={selection.favoriteOptions}
    modelGroups={selection.modelGroups}
    thinking={selection.thinkingOptions}
    modes={selection.modeOptions}
    rootRows={selection.rootRows}
    modelsReady={selection.modelsReady}
    pane={selection.pane}
    setPane={selection.setPane}
    onPickFavorite={(option) => { close(); selection.pickFavorite(option); }}
    onToggleFavorite={selection.toggleFavorite}
    onPickModel={(option) => { backToRoot(); selection.pickModel(option); }}
    onPickThinking={(level) => { backToRoot(); selection.pickThinking(level); }}
    onPickMode={(mode) => { backToRoot(); selection.pickMode(mode); }}
  />;
}

export function SessionSelectorView({ selection }: { selection: SessionSelection }): JSX.Element {
  const [hover, setHover] = useState(false);
  const { open, setOpen, pane, setPane } = selection;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const escape = () => {
    if (pane !== 'root') { setPane('root'); return; }
    close();
    // Only Escape returns focus; outside clicks and picks keep their destination.
    triggerRef.current?.focus({ preventScroll: true });
  };
  useDismissMenu(open, escape, close);
  return <span onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    style={{ position: 'relative', display: 'inline-flex', flex: 'none', maxWidth: 280 }}>
    <SelectionTrigger selection={selection} hover={hover} triggerRef={triggerRef} />
    {open ? <SessionSelectionMenu selection={selection} close={close} /> : null}
  </span>;
}

export function AgentSelectorView({ selection }: { selection: SessionSelection }): JSX.Element | null {
  const L = useVocab();
  const { agentOpen: open, setAgentOpen: setOpen } = selection;
  const [hover, setHover] = useState(false);
  // One level, so Escape has nothing to retreat through: it closes, the way a click outside does.
  const close = () => setOpen(false);
  useDismissMenu(open, close, close);
  const parts = agentChipParts(selection.agentOptions, selection.agentName);
  if (!hasAgentChoice(selection.agentOptions)) return null;
  const label = parts.name ?? L.wbAgentDefault;

  return (
    <span
      data-chip="agent"
      data-agent-following-default={parts.followingDefault ? 'true' : 'false'}
      title={[
        `${L.wbAgent} · ${label}`,
        parts.followingDefault ? L.wbAgentFollowDefault : null,
        parts.description,
      ].filter(Boolean).join('\n')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
      style={{
        ...quietChipStyle(hover || open), position: 'relative', flex: 'none', maxWidth: 180,
        // Following the host default reads a step quieter than an agent the conversation picked.
        color: parts.followingDefault ? 'var(--proto-muted)' : 'var(--proto-ink-2)',
      }}
    >
      <AgentGlyph />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {open ? (
        <AgentMenu
          agents={selection.agentOptions}
          overridden={!parts.followingDefault}
          // Close after choosing an environment.
          onPick={(name) => { close(); selection.pickAgent(name); }}
        />
      ) : null}
    </span>
  );
}

/** Clean mode uses an inverted fill when enabled; locked while the session is being created. */
export function CleanToggleView({ on, disabled = false, onToggle }: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  return <button type="button" data-chip="clean" className={MENU_FOCUS} aria-pressed={on}
    disabled={disabled} title={L.wbCleanHint}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onClick={(event) => { event.stopPropagation(); if (!disabled) onToggle(); }}
    style={{
      ...quietChipStyle(hover && !disabled), flex: 'none', whiteSpace: 'nowrap',
      ...(on ? cleanEnabledStyle(hover && !disabled) : { color: 'var(--proto-muted)' }),
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
    }}>
    <CleanGlyph />
    {L.wbClean}
  </button>;
}

function cleanEnabledStyle(hover: boolean) {
  return {
    background: hover ? 'var(--ink-solid-hover)' : 'var(--ink-solid-bg)',
    color: 'var(--ink-solid-fg)',
  };
}

const WORKSPACE_ACTION_STYLE = {
  flex: 'none', font: '500 12px var(--font-ui)', color: 'var(--proto-muted)',
  border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-chip)', padding: '4px 8px',
  background: 'var(--material-control-bg)', boxShadow: 'var(--material-control-shadow)', cursor: 'pointer',
} as const;

/** What the running clean session's chip opens: where its workspace is, to copy or open. */
export function CleanWorkspacePanel({ workspaceDir }: { workspaceDir: string }): JSX.Element {
  const L = useVocab();
  const { copiedKey, copy } = useClipboardFeedback<'path'>();
  const copied = copiedKey === 'path';
  return <div data-clean-workspace="" style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 360, maxWidth: '80vw', padding: 4 }}>
    <div style={{ fontSize: 12, fontWeight: 550, color: 'var(--proto-muted)' }}>{L.wbCleanWorkspace}</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ flex: 1, minWidth: 0, font: `500 12px ${MONO}`, color: 'var(--proto-ink)', wordBreak: 'break-all', userSelect: 'all' }}>
        {workspaceDir}
      </span>
      {canRevealServerPath() ? (
        <button type="button" data-action="reveal" className={MENU_FOCUS} style={WORKSPACE_ACTION_STYLE}
          onClick={() => void revealPath(workspaceDir)}>{L.wbFileOpenFolder}</button>
      ) : null}
      <button type="button" data-action="copy" className={MENU_FOCUS}
        style={{ ...WORKSPACE_ACTION_STYLE, color: copied ? 'var(--proto-ink)' : WORKSPACE_ACTION_STYLE.color }}
        onClick={() => void copy(workspaceDir, 'path')}>{copied ? L.wbCopied : L.wbCopy}</button>
    </div>
  </div>;
}

/** A running clean session: the same chip, read-only, opening its workspace. The path arrives with
 *  the session's row, so a session created a moment ago shows the chip before it can open. */
export function CleanWorkspaceChip({ workspaceDir }: { workspaceDir: string | null }): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const chip = <button type="button" data-chip="clean" data-clean-running="" className={MENU_FOCUS}
    title={L.wbCleanHint} disabled={!workspaceDir}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    style={{ ...quietChipStyle(false), ...cleanEnabledStyle((hover || open) && !!workspaceDir),
      flex: 'none', whiteSpace: 'nowrap', cursor: workspaceDir ? 'pointer' : 'default' }}>
    <CleanGlyph />
    {L.wbClean}
  </button>;
  if (!workspaceDir) return chip;
  return <Popover trigger={chip} side="top" align="end" open={open} onOpenChange={setOpen}>
    <CleanWorkspacePanel workspaceDir={workspaceDir} />
  </Popover>;
}
