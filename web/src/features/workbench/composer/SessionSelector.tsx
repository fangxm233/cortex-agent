import { useRef, useState } from 'react';
import { useVocab } from '@/i18n';
import { agentChipParts, hasAgentChoice, selectionChipParts } from '@/features/session/list/selection-menu';
import type { SessionSelection } from '@/features/session/composer/useSessionSelection';
import { AgentMenu } from './AgentMenu';
import { MENU_FOCUS, useDismissMenu } from '@/design/MenuChrome';
import { SelectionMenu } from './SelectionMenu';

// The composer's two chips, drawn off the one headless `useSessionSelection`: the engine chip and,
// to its left, the environment chip. The rules behind both live in that hook.

const CHIP_FONT = "500 11.5px 'IBM Plex Mono',monospace";

export function SessionSelectorView({ selection }: { selection: SessionSelection }): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  const { open, setOpen, pane, setPane } = selection;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const escape = () => {
    if (pane !== 'root') { setPane('root'); return; }
    close();
    // The focused menu row is about to unmount. Only Escape returns focus; a click
    // outside must keep its destination, and picks retain their existing semantics.
    triggerRef.current?.focus({ preventScroll: true });
  };
  useDismissMenu(open, escape, close);
  const backToRoot = () => setPane('root');
  const parts = selectionChipParts(selection.effective);

  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', display: 'inline-flex', flex: 'none', maxWidth: 280 }}
    >
      <button
        type="button"
        data-chip="selection"
        ref={triggerRef}
        className={MENU_FOCUS}
        aria-expanded={open}
        // The chip shows the model.
        title={`${L.wbModel} · ${selection.effective.model}`}
        onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
        style={{
          font: CHIP_FONT, background: 'transparent',
          border: `1.5px solid ${hover ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`,
          color: hover ? 'var(--proto-accent)' : 'var(--proto-muted)',
          padding: '0 12px', height: 30, borderRadius: 'var(--r-pill)', boxSizing: 'border-box', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: 280,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {parts.main}
        </span>
        {parts.sub ? (
          <span style={{ color: 'var(--proto-muted)', flex: 'none' }}>· {parts.sub}</span>
        ) : null}
      </button>
      {open ? (
        <SelectionMenu
          favorites={selection.favoriteOptions}
          modelGroups={selection.modelGroups}
          thinking={selection.thinkingOptions}
          modes={selection.modeOptions}
          rootRows={selection.rootRows}
          modelsReady={selection.modelsReady}
          pane={pane}
          setPane={setPane}
          onPickFavorite={(option) => { close(); selection.pickFavorite(option); }}
          onToggleFavorite={selection.toggleFavorite}
          onPickModel={(option) => { backToRoot(); selection.pickModel(option); }}
          onPickThinking={(level) => { backToRoot(); selection.pickThinking(level); }}
          onPickMode={(mode) => { backToRoot(); selection.pickMode(mode); }}
        />
      ) : null}
    </span>
  );
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
  const lit = hover || !parts.followingDefault;

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
        position: 'relative', font: CHIP_FONT,
        border: `1.5px solid ${lit ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`,
        color: lit ? 'var(--proto-accent)' : 'var(--proto-muted)',
        padding: '0 12px', height: 30, borderRadius: 'var(--r-pill)', boxSizing: 'border-box', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', maxWidth: 180,
      }}
    >
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
