import { useState, type CSSProperties, type ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { useLang } from '@/i18n';
import type { MetadataSession } from '@/features/session/metadata/SessionMetadata';
import { ChatSessionMenu } from './ChatSessionMenu';
import { workbenchCopy } from '@/features/workbench/workbench-copy';
import { SessionIdModal } from './SessionIdModal';
import { useNotes } from '@/features/notes/NotesProvider';
import { useDockIntake } from '@/design/dock-intake';
import { useShellModals } from '@/shell/useShellModals';

const MONO = "'IBM Plex Mono',monospace";

function iconButtonStyle(hover: boolean, active: boolean): CSSProperties {
  return {
    width: 28,
    height: 28,
    padding: 0,
    border: 0,
    borderRadius: 'var(--r-chip)',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    background: hover || active ? 'var(--proto-line-2)' : 'transparent',
    color: active ? 'var(--proto-accent)' : hover ? 'var(--proto-ink)' : 'var(--proto-muted)',
  };
}

function HeaderIconButton({ active = false, title, attr, onClick, children }: {
  active?: boolean;
  title: string;
  /** Data attribute the rest of the app (and its tests) uses to find this control. */
  attr?: Record<string, string>;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      {...attr}
      className={MENU_FOCUS}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={iconButtonStyle(hover, active)}
    >
      {children}
    </button>
  );
}

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

function NotesGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v5h4M9 12h6M9 16h6" />
    </svg>
  );
}

// The chat header's Browser/Notes controls are icon-only here, unlike the labelled chips the overview
// uses: this row also carries the title and the project chip, so the buttons give the width back.
function BrowserIconButton(): JSX.Element | null {
  const { canDock, active, activeKind, openWeb } = useDockIntake();
  const copy = workbenchCopy(useLang());
  if (!canDock) return null;
  return (
    <HeaderIconButton
      attr={{ 'data-browser-button': '' }}
      active={active && activeKind === 'web'}
      title={copy.openWebPage}
      onClick={openWeb}
    >
      <GlobeGlyph />
    </HeaderIconButton>
  );
}

export function ChatHeader({
  title,
  running,
  projectName,
  backendSessionId,
  sessionName,
  metadataSession,
}: {
  title: string;
  running: boolean;
  /** The session's project, already resolved by CenterChat. Null ⇒ no chip. */
  projectName: string | null;
  backendSessionId: string | null;
  sessionName: string | null;
  metadataSession: MetadataSession | null;
}): JSX.Element {
  const notes = useNotes();
  // Edit → Copy session ID and this menu both reach the same modal, so its open flag lives in
  // the shell modal registry (shell/useShellModals). The modal itself stays here: it needs the ids from this subtree.
  const shellModals = useShellModals();

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
        <BrowserIconButton />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <HeaderIconButton
            attr={{ 'data-notes-button': '' }}
            active={notes.isOpen}
            title={`${notes.copy.title} · ⌘⇧N`}
            onClick={() => notes.isOpen ? notes.close() : notes.open()}
          >
            <NotesGlyph />
          </HeaderIconButton>
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
        <ChatSessionMenu session={metadataSession} onSessionId={shellModals.openSessionId} />
      </div>
      {shellModals.sessionIdOpen ? (
        <SessionIdModal
          cortexId={sessionName}
          backendUuid={backendSessionId}
          onClose={shellModals.closeSessionId}
        />
      ) : null}
    </div>
  );
}
