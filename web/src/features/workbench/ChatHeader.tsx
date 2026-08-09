// input:  Session title, identifiers, command palette and project notes
// output: Desktop chat header navigation controls
// pos:    Desktop chat header controls
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useState } from 'react';
import { useVocab } from '@/i18n';
import { SessionIdModal } from './SessionIdModal';
import { NotesButton } from '@/features/notes/NotesButton';
import { useNotes } from '@/features/notes/NotesProvider';

const MONO = "'IBM Plex Mono',monospace";

export function ChatHeader({
  title,
  onCmdK,
  backendSessionId,
  sessionName,
}: {
  title: string;
  onCmdK: () => void;
  backendSessionId: string | null;
  sessionName: string | null;
}): JSX.Element {
  const L = useVocab();
  const notes = useNotes();
  const [cmdkHover, setCmdkHover] = useState(false);
  const [moreHover, setMoreHover] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [sessionIdOpen, setSessionIdOpen] = useState(false);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreMenuOpen(false);
    };
    const close = () => setMoreMenuOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', close);
    };
  }, [moreMenuOpen]);

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
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          maxWidth: 320,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, color: 'var(--proto-muted-2)' }}>
        <span
          onClick={onCmdK}
          onMouseEnter={() => setCmdkHover(true)}
          onMouseLeave={() => setCmdkHover(false)}
          style={{ font: `500 11px ${MONO}`, cursor: 'pointer', color: cmdkHover ? 'var(--proto-ink)' : undefined }}
        >
          ⌘K
        </span>
        <span style={{ width: 1, height: 18, background: 'var(--proto-line)', flex: 'none' }} />
        <NotesButton
          count={notes.vm.activeCount}
          active={notes.isOpen}
          copy={notes.copy}
          onClick={() => notes.isOpen ? notes.close() : notes.open()}
        />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <span
            data-chip="more"
            aria-label="Session menu"
            onMouseEnter={() => setMoreHover(true)}
            onMouseLeave={() => setMoreHover(false)}
            onClick={(event) => {
              event.stopPropagation();
              setMoreMenuOpen((open) => !open);
            }}
            style={{
              fontSize: 15,
              lineHeight: 1,
              letterSpacing: 1,
              cursor: 'pointer',
              color: moreHover || moreMenuOpen ? 'var(--proto-ink)' : undefined,
            }}
          >
            ⋯
          </span>
          {moreMenuOpen ? (
            <span
              onClick={(event) => event.stopPropagation()}
              style={{
                position: 'absolute',
                right: 0,
                top: 24,
                minWidth: 132,
                background: 'var(--proto-card)',
                border: '1px solid var(--proto-line)',
                borderRadius: 9,
                boxShadow: '0 14px 40px rgba(16,24,40,.2)',
                overflow: 'hidden',
                zIndex: 40,
              }}
            >
              <div
                onClick={() => {
                  setMoreMenuOpen(false);
                  setSessionIdOpen(true);
                }}
                style={{
                  padding: '9px 13px',
                  fontSize: 12.5,
                  color: 'var(--proto-ink)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {L.wbSessionId}
              </div>
            </span>
          ) : null}
        </span>
      </div>
      {sessionIdOpen ? (
        <SessionIdModal
          cortexId={sessionName}
          backendUuid={backendSessionId}
          onClose={() => setSessionIdOpen(false)}
        />
      ) : null}
    </div>
  );
}
