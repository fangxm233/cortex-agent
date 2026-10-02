import { useEffect, useState } from 'react';
import { MENU_BUTTON_STYLE, MENU_FOCUS, MENU_SURFACE } from '@/design/MenuChrome';
import { useLang, useVocab } from '@/i18n';
import { workbenchCopy } from '@/features/workbench/workbench-copy';
import { SessionMetadata, type MetadataSession, type SessionMetadataActions } from '@/features/session/metadata/SessionMetadata';
import { SessionMetadataMenuItems } from '@/features/session/metadata/SessionMetadataMenuItems';

function useMenuDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', close); };
  }, [open, close]);
}

function MenuPanel({ actions, close, onSessionId }: {
  actions: SessionMetadataActions; close: () => void; onSessionId: () => void;
}): JSX.Element {
  const L = useVocab();
  return <span onClick={(event) => event.stopPropagation()}
    style={{ position: 'absolute', right: 0, top: 24, minWidth: 132, ...MENU_SURFACE,
      border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)', overflow: 'hidden', zIndex: 40 }}>
    <SessionMetadataMenuItems actions={actions} onClose={close} />
    <button type="button" className={MENU_FOCUS} onClick={() => { close(); onSessionId(); }}
      style={{ ...MENU_BUTTON_STYLE, background: 'transparent', padding: '9px 13px', fontSize: 12.5,
        color: 'var(--proto-ink)', cursor: 'pointer', whiteSpace: 'nowrap' }}>{L.wbSessionId}</button>
  </span>;
}

function HeaderMenu({ actions, onSessionId }: {
  actions: SessionMetadataActions; onSessionId: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const copy = workbenchCopy(useLang());
  const close = () => setOpen(false);
  useMenuDismiss(open, close);
  return <span style={{ position: 'relative', display: 'inline-flex' }}>
    <button type="button" className={MENU_FOCUS} data-chip="more" aria-label={copy.sessionMenu}
      aria-expanded={open} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      style={{ width: 28, height: 28, padding: 0, border: 0, borderRadius: 'var(--r-chip)',
        display: 'grid', placeItems: 'center', cursor: 'pointer',
        background: hover || open ? 'var(--proto-line-2)' : 'transparent',
        color: hover || open ? 'var(--proto-ink)' : 'var(--proto-muted)',
        fontSize: 15, lineHeight: 1, letterSpacing: 1 }}>⋯</button>
    {open && <MenuPanel actions={actions} close={close} onSessionId={onSessionId} />}
  </span>;
}

export function ChatSessionMenu({ session, onSessionId }: {
  session: MetadataSession | null; onSessionId: () => void;
}): JSX.Element {
  return <SessionMetadata session={session}>
    {(actions) => <HeaderMenu actions={actions} onSessionId={onSessionId} />}
  </SessionMetadata>;
}
