import { useMemo, useState, type ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { IconButton } from '@/design/IconButton';
import { useVocab } from '@/i18n';
import type { MetadataSession } from '@/features/session/metadata/SessionMetadata';
import { ChatSessionMenu } from './ChatSessionMenu';
import { SessionIdModal } from './SessionIdModal';
import { useNotes } from '@/features/notes/NotesProvider';
import { NotesGlyph } from '@/features/notes/NotesGlyph';
import { useDockIntake } from '@/design/dock-intake';
import { useFitLevel } from '@/lib/useFitLevel';
import { HeaderCapsuleFitContext, type HeaderCapsuleFit } from '@/features/session/rail/ActivityChip';

function GlobeGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" />
      <path d="M1.7 8h12.6M8 1.7c-1.8 1.8-2.7 4-2.7 6.3s.9 4.5 2.7 6.3c1.8-1.8 2.7-4 2.7-6.3S9.8 3.5 8 1.7z" />
    </svg>
  );
}

// The chat header's Browser/Notes controls are icon-only here, unlike the labelled chips the overview
// uses: this row also carries the title and the project chip, so the buttons give the width back.
function BrowserIconButton(): JSX.Element | null {
  const { canDock, active, activeKind, openWeb } = useDockIntake();
  const L = useVocab();
  if (!canDock) return null;
  return (
    <IconButton
      data-browser-button=""
      size={28}
      tone="neutral"
      active={active && activeKind === 'web'}
      aria-pressed={active && activeKind === 'web'}
      label={L.wbOpenWebPage}
      onClick={openWeb}
    >
      <GlobeGlyph />
    </IconButton>
  );
}

/** Team mode: a worker's header leads with its lead session, one click back to it. */
export interface ChatHeaderParent {
  title: string;
  onSelect: () => void;
}

function ParentCrumb({ parent }: { parent: ChatHeaderParent }): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-lead-crumb=""
      className={MENU_FOCUS}
      title={`${L.wbTeamOpenLead} · ${parent.title}`}
      onClick={parent.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        maxWidth: 220,
        flexShrink: 1,
        padding: 0,
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        color: hover ? 'var(--proto-ink)' : 'var(--proto-muted)',
      }}
    >
      <span aria-hidden="true" style={{ flex: 'none' }}>‹</span>
      <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{parent.title}</span>
      <span aria-hidden="true" style={{ flex: 'none', color: 'var(--proto-muted-3)' }}>/</span>
    </button>
  );
}

// The header folds as its pane narrows, one step at a time and only as far as it must (useFitLevel):
// the title first gives up width down to TITLE_MIN, then
//   1 · the project crumb goes,
//   2 · the board capsule folds to its flag and amber count,
//   3 · the team capsule folds to its dots and a worker count,
//   4 · the title may shrink below TITLE_MIN,
//   5 · the capsules go (the last resort of a pane narrower than any header).
// Globe, notes and ⋯ never fold: they are how the header is used, so they always stay in the pane.
const TITLE_MIN = 140;
const FIT_MAX = 5;

/** The row no longer fits when the action cluster's right edge runs past the header's content box. */
function headerOverflows(header: HTMLDivElement): boolean {
  const actions = header.querySelector<HTMLElement>('[data-header-actions]');
  if (!actions) return false;
  const padRight = parseFloat(getComputedStyle(header).paddingRight) || 0;
  return actions.getBoundingClientRect().right > header.getBoundingClientRect().right - padRight + 0.5;
}

export function ChatHeader({
  title,
  running,
  projectName,
  backendSessionId,
  metadataSession,
  parent,
  team,
  board,
}: {
  title: string;
  running: boolean;
  /** The session's project, already resolved by CenterChat. Null ⇒ no crumb. */
  projectName: string | null;
  backendSessionId: string | null;
  metadataSession: MetadataSession | null;
  parent?: ChatHeaderParent | null;
  /** Team mode: a lead's team capsule, first among the header's actions. */
  team?: ReactNode;
  /** The bound board's capsule, beside the team's. */
  board?: ReactNode;
}): JSX.Element {
  const L = useVocab();
  const notes = useNotes();
  const [sessionIdOpen, setSessionIdOpen] = useState(false);
  const { ref, level } = useFitLevel<HTMLDivElement>(FIT_MAX, headerOverflows,
    [title, projectName ?? '', parent?.title ?? '', team ? 't' : '', board ? 'b' : ''].join('\n'));
  const fit = useMemo<HeaderCapsuleFit>(() => ({
    board: level >= 2 ? 'compact' : 'full',
    team: level >= 3 ? 'compact' : 'full',
  }), [level]);

  return (
    <div
      ref={ref}
      data-chat-header=""
      data-fit-level={level}
      style={{
        height: 50,
        flex: 'none',
        minWidth: 0,
        boxSizing: 'border-box',
        borderBottom: '1px solid var(--proto-line)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 14px 0 20px',
      }}
    >
      {running && (
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--proto-accent)',
            flex: 'none',
          }}
        />
      )}
      {/* "project /" leads the title as plain muted text, the way the lead crumb does for a worker. */}
      {projectName && level < 1 && (
        <span
          data-project-crumb=""
          title={`${L.project} · ${projectName}`}
          style={{
            flex: 'none', maxWidth: 180, fontSize: 13, color: 'var(--proto-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {projectName}
          <span aria-hidden="true" style={{ color: 'var(--proto-muted-3)' }}>{' /'}</span>
        </span>
      )}
      {parent && <ParentCrumb parent={parent} />}
      <div
        title={title}
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          flex: '0 1 auto',
          minWidth: level >= 4 ? 0 : TITLE_MIN,
          maxWidth: 360,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      <div data-header-actions="" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flex: 'none', color: 'var(--proto-muted)' }}>
        {level < 5 && (
          <HeaderCapsuleFitContext.Provider value={fit}>
            {team}
            {board}
          </HeaderCapsuleFitContext.Provider>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' }}>
          <BrowserIconButton />
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <IconButton
              data-notes-button=""
              size={28}
              tone="neutral"
              active={notes.isOpen}
              aria-pressed={notes.isOpen}
              label={`${L.noteTitle} · ⌘⇧N`}
              onClick={() => notes.isOpen ? notes.close() : notes.open()}
            >
              <NotesGlyph />
            </IconButton>
            {/* The button lost its label in this row, but not its count: a quiet number on the
                button's corner keeps it on screen rather than demoting it into a tooltip nobody
                hovers. A plain figure on the card, not a filled accent badge — a note is not an alert. */}
            {notes.vm.activeCount > 0 && (
              <span
                aria-hidden="true"
                data-notes-count=""
                style={{
                  position: 'absolute',
                  top: -2,
                  right: -4,
                  minWidth: 15,
                  height: 15,
                  padding: '0 3px',
                  boxSizing: 'border-box',
                  borderRadius: 'var(--r-pill)',
                  font: '550 10.5px/1 var(--font-ui)',
                  fontVariantNumeric: 'tabular-nums',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--proto-card)',
                  boxShadow: '0 0 0 1px var(--proto-line-3)',
                  color: 'var(--proto-ink-2)',
                  pointerEvents: 'none',
                }}
              >
                {notes.vm.activeCount}
              </span>
            )}
          </span>
          <ChatSessionMenu session={metadataSession} onSessionId={() => setSessionIdOpen(true)} />
        </span>
      </div>
      {sessionIdOpen ? (
        <SessionIdModal
          sessionId={metadataSession?.sessionId}
          backendUuid={backendSessionId}
          onClose={() => setSessionIdOpen(false)}
        />
      ) : null}
    </div>
  );
}
