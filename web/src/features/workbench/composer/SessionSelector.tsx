import { useRef, useState, type RefObject } from 'react';
import { useVocab } from '@/i18n';
import { agentChipParts, hasAgentChoice, selectionChipParts } from '@/features/session/list/selection-menu';
import type { SessionSelection } from '@/features/session/composer/useSessionSelection';
import { AgentMenu } from './AgentMenu';
import { MENU_FOCUS, useDismissMenu } from '@/design/MenuChrome';
import { SelectionMenu } from './SelectionMenu';
import { AgentGlyph, ModelGlyph, quietChipStyle } from './composer-chip';

// The composer's two chips, drawn off the one headless `useSessionSelection`: the engine chip and,
// to its left, the environment chip. The rules behind both live in that hook. Both are the toolbar's
// filled quiet chip (`composer-chip`), and the model chip reads "model · sub".

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
