import { useState, type ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { IconButton } from '@/design/IconButton';
import { useVocab } from '@/i18n';
import type { MetadataSession } from '@/features/session/metadata/SessionMetadata';
import { ChatSessionMenu } from './ChatSessionMenu';
import { SessionIdModal } from './SessionIdModal';
import { useNotes } from '@/features/notes/NotesProvider';
import { NotesGlyph } from '@/features/notes/NotesGlyph';
import { useDockIntake } from '@/design/dock-intake';
import { ProjectGlyph } from '@/features/workbench/composer/composer-chip';

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
  /** The session's project, already resolved by CenterChat. Null ⇒ no chip. */
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

  return (
    <div
      style={{
        height: 50,
        flex: 'none',
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
      {parent && <ParentCrumb parent={parent} />}
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          minWidth: 0,
          maxWidth: 320,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      {projectName && (
        <span
          data-project-chip=""
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 22,
            fontSize: 12,
            color: 'var(--proto-muted)',
            background: 'var(--proto-line-2)',
            borderRadius: 6,
            padding: '0 8px 0 7px',
            flex: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <ProjectGlyph />
          {projectName}
        </span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, color: 'var(--proto-muted)' }}>
        {team}
        {board}
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
