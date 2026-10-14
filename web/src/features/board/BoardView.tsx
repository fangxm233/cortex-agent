import { useCallback, useState, type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { MONO } from '@/design/MenuChrome';
import { useToastOptional } from '@/design/Toast';
import { useVocab } from '@/i18n';
import { downloadFile, boardFilePath } from '@/lib/files';
import { isNativeShell } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { docKindOf } from '@/features/media/doc-kind';
import { DecisionCardGroup } from '@/features/session/interaction/DecisionCards';
import { shortSessionId } from '@/features/session/metadata/short-session-id';
import { BoardFrame } from './BoardFrame';
import { BoardLiveStrip, type CloseStatus } from './BoardLiveStrip';
import { fileNameOf, mediaKindOfName, resolveBoardRef } from './board-paths';
import { useBoard, useCloseBoard } from './useBoard';
import { useBoardDocument } from './useBoardDocument';
import { useBoardLiveSync } from './useBoardLiveSync';

// One board: the native live strip, the decision stream it can unfold, and the agent-written body.
// Shared by the desktop dock tab and the mobile sheet; each host says how to open a session.

const CENTERED: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, padding: 20,
  color: 'var(--proto-muted)', font: `500 11.5px ${MONO}`, textAlign: 'center',
};

/** Open a board-relative file the way the rest of the app previews files: the dock while it is
 *  open, the preview modals otherwise; anything with no previewer downloads. */
function useOpenBoardFile(projectId: string, slug: string): (ref: string) => void {
  const { openMedia } = useMediaViewer();
  const { openDoc } = useDocViewer();
  return useCallback((ref: string) => {
    const rel = resolveBoardRef(slug, ref);
    if (!rel) return;
    const name = fileNameOf(rel);
    const path = boardFilePath(projectId, rel);
    const media = mediaKindOfName(name);
    if (media) return openMedia({ kind: media, name, path });
    const doc = docKindOf(name);
    if (doc) return openDoc({ kind: doc, name, path });
    void downloadFile(path, name).catch(() => {});
  }, [projectId, slug, openMedia, openDoc]);
}

function openLink(href: string): void {
  if (isNativeShell()) void openExternalUrl(href).catch(() => {});
  else window.open(href, '_blank', 'noopener,noreferrer');
}

function DecisionStream({ decisions, sessions, touch }: {
  decisions: ReturnType<typeof useBoard>['decisions'];
  sessions: SessionInfo[];
  touch?: boolean;
}): JSX.Element {
  const L = useVocab();
  const label = (id: string) => {
    const hit = sessions.find((s) => s.sessionId === id);
    return hit?.workerName || hit?.label || shortSessionId(id);
  };
  return (
    <div data-board-decision-stream="" style={{
      flex: 'none', maxHeight: '45%', overflowY: 'auto', margin: '8px 12px 0', padding: '2px 12px 10px',
      borderRadius: 'var(--r-card)', background: 'var(--material-inset-bg)', border: '1px solid var(--border-card)',
    }}>
      {decisions.length === 0
        ? <div style={{ ...CENTERED, minHeight: 0, padding: '10px 0' }}>{L.boardNoDecisions}</div>
        // Read-only: no sessionId goes in, so the cards carry no approve/revise controls. Acting on a
        // decision happens in the session that raised it, which is why each card names its source.
        : [...decisions].reverse().map((entry, i) => (
          <div key={`${entry.ts}:${entry.item.id}:${i}`}>
            <div style={{ font: `400 11px ${MONO}`, color: 'var(--proto-muted)', marginTop: 10 }}>{label(entry.sessionId)}</div>
            <DecisionCardGroup decisions={[entry.item]} touch={touch} />
          </div>
        ))}
    </div>
  );
}

function LegacyFiles({ files, onOpen }: { files: string[]; onOpen: (ref: string) => void }): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ ...CENTERED, flexDirection: 'column', gap: 8 }} data-board-empty="">
      <span>{L.boardNoBody}</span>
      {files.length > 0 && (
        <span style={{ display: 'flex', gap: 12 }}>
          {files.map((name) => (
            <button key={name} type="button" data-board-file={name} onClick={() => onOpen(name)}
              style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', font: `500 12px ${MONO}`, color: 'var(--proto-accent)' }}>
              {name}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

export function BoardView({ boardId, onOpenSession, touch }: {
  boardId: string;
  onOpenSession: (session: SessionInfo) => void;
  /** Mobile: touch-sized decision cards. */
  touch?: boolean;
}): JSX.Element {
  const L = useVocab();
  const toast = useToastOptional();
  const data = useBoard(boardId);
  const close = useCloseBoard(boardId);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useBoardLiveSync(useCallback((id: string) => { if (id === boardId) setRefresh((n) => n + 1); }, [boardId]));

  const { board } = data;
  const projectId = board?.projectId ?? '';
  const slug = board?.slug ?? '';
  const openFile = useOpenBoardFile(projectId, slug);
  const srcDoc = useBoardDocument({
    projectId,
    slug,
    body: data.body.kind === 'body' ? data.body.html : null,
    style: data.style,
    refresh,
  });

  if (!board) {
    return <div style={CENTERED}>{data.missing ? L.boardMissing : L.boardLoading}</div>;
  }

  const onClose = (status: CloseStatus, note: string) => {
    close.mutate({ boardId, status, note: note || undefined }, {
      onError: (error) => toast?.toast({ title: L.boardCloseFailed, description: error.message, tone: 'failed' }),
    });
  };

  return (
    <div data-board-view={boardId} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <BoardLiveStrip
        board={board}
        sessions={data.sessions}
        decisionCount={data.decisions.length}
        decisionsOpen={decisionsOpen}
        onToggleDecisions={() => setDecisionsOpen((v) => !v)}
        onOpenSession={onOpenSession}
        closing={close.isPending}
        onClose={onClose}
      />
      {decisionsOpen && <DecisionStream decisions={data.decisions} sessions={data.sessions} touch={touch} />}
      <div data-board-scroll="" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px 16px' }}>
        {data.body.kind === 'empty'
          ? <LegacyFiles files={data.body.files} onOpen={openFile} />
          : srcDoc === null
            ? <div style={CENTERED}>{L.boardLoading}</div>
            : <BoardFrame srcDoc={srcDoc} title={board.title} onOpen={openFile} onLink={openLink} />}
      </div>
    </div>
  );
}
