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

const MONO = "'IBM Plex Mono',monospace";

function FolderGlyph(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flex: 'none' }} aria-hidden="true">
      <path d="M1.6 12.2V4.4a1.3 1.3 0 0 1 1.3-1.3h2.7l1.3 1.5h5.5a1.3 1.3 0 0 1 1.3 1.3v1.2" stroke="var(--proto-accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2.9 13h8.8a1.2 1.2 0 0 0 1.13-.79l1.4-3.9A.6.6 0 0 0 13.66 7.5H5.1a1.2 1.2 0 0 0-1.13.79l-1.63 4.5A.5.5 0 0 0 2.9 13z" fill="var(--proto-accent)" />
    </svg>
  );
}

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
      tone="accent"
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
        fontSize: 13.5,
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
  sessionName,
  metadataSession,
  parent,
  team,
}: {
  title: string;
  running: boolean;
  /** The session's project, already resolved by CenterChat. Null ⇒ no chip. */
  projectName: string | null;
  backendSessionId: string | null;
  sessionName: string | null;
  metadataSession: MetadataSession | null;
  parent?: ChatHeaderParent | null;
  /** Team mode: a lead's team capsule, first among the header's actions. */
  team?: ReactNode;
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
        gap: 10,
        padding: '0 20px',
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
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          maxWidth: 420,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      {projectName && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            font: `500 11px ${MONO}`,
            color: 'var(--proto-muted)',
            background: 'var(--proto-line-2)',
            borderRadius: 'var(--r-chip)',
            padding: '2px 7px',
            flex: 'none',
          }}
        >
          <FolderGlyph />
          {projectName}
        </span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--proto-muted)' }}>
        {team}
        <BrowserIconButton />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <IconButton
            data-notes-button=""
            size={28}
            tone="accent"
            active={notes.isOpen}
            aria-pressed={notes.isOpen}
            label={`${L.noteTitle} · ⌘⇧N`}
            onClick={() => notes.isOpen ? notes.close() : notes.open()}
          >
            <NotesGlyph />
          </IconButton>
          {/* The button lost its label in this row, but not its count: a badge keeps the number on
              screen rather than demoting it into a tooltip nobody hovers. */}
          {notes.vm.activeCount > 0 && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 16,
                height: 16,
                padding: '0 3px',
                boxSizing: 'border-box',
                borderRadius: 'var(--r-pill)',
                font: `600 11px ${MONO}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--proto-accent)',
                color: 'var(--ink-solid-fg)',
              }}
            >
              {notes.vm.activeCount}
            </span>
          )}
        </span>
        <ChatSessionMenu session={metadataSession} onSessionId={() => setSessionIdOpen(true)} />
      </div>
      {sessionIdOpen ? (
        <SessionIdModal
          cortexId={sessionName}
          sessionId={metadataSession?.sessionId}
          backendUuid={backendSessionId}
          onClose={() => setSessionIdOpen(false)}
        />
      ) : null}
    </div>
  );
}
