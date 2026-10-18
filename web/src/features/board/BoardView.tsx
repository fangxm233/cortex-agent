import { useCallback, useState, type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { downloadFile, boardFilePath } from '@/lib/files';
import { isNativeShell } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';
import { useMediaViewer } from '@/features/media/MediaViewer';
import { useDocViewer } from '@/features/media/DocViewer';
import { docKindOf } from '@/features/media/doc-kind';
import { BoardDecisionStream } from './BoardDecisionStream';
import { BoardFrame } from './BoardFrame';
import { BoardLiveStrip } from './BoardLiveStrip';
import { fileNameOf, mediaKindOfName, resolveBoardRef } from './board-paths';
import { useBoard } from './useBoard';
import { useBoardDocument } from './useBoardDocument';
import { useBoardUpdated } from './useBoardLiveSync';

// One board: the native live strip, the decision stream it can unfold, and the agent-written body.
// Shared by the desktop dock tab and the mobile sheet; each host says how to open a session.
// The strip and the stream sit on the pane's glass; the body below is the document, on a paper fill
// of its own (as the dock's file documents are), so the board reads as one page under a status line.

const CENTERED: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, padding: 20,
  color: 'var(--proto-muted)', fontSize: 12.5, textAlign: 'center',
};

/** The document's fill: the card colour, slightly let through so the pane's glass still tints it. */
const PAPER = 'color-mix(in srgb, var(--proto-card) 78%, transparent)';

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

function LegacyFiles({ files, onOpen }: { files: string[]; onOpen: (ref: string) => void }): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ ...CENTERED, flexDirection: 'column', gap: 8 }} data-board-empty="">
      <span>{L.boardNoBody}</span>
      {files.length > 0 && (
        <span style={{ display: 'flex', gap: 12 }}>
          {files.map((name) => (
            <button key={name} type="button" data-board-file={name} onClick={() => onOpen(name)}
              style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 500, color: 'var(--proto-accent)' }}>
              {name}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

export function BoardView({ boardId, onOpenSession, touch, showTitle = true }: {
  boardId: string;
  onOpenSession: (session: SessionInfo) => void;
  /** Mobile: touch-sized decision cards and a narrower gutter. */
  touch?: boolean;
  /** The strip leads with the board's title. The dock turns it off: its tab already names the board. */
  showTitle?: boolean;
}): JSX.Element {
  const L = useVocab();
  const data = useBoard(boardId);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useBoardUpdated(useCallback((id: string) => { if (id === boardId) setRefresh((n) => n + 1); }, [boardId]));

  const { board } = data;
  const gutter = touch ? 16 : 20;
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

  return (
    <div data-board-view={boardId} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <BoardLiveStrip
        board={board}
        sessions={data.sessions}
        decisionCount={data.decisions.length}
        decisionsOpen={decisionsOpen}
        onToggleDecisions={() => setDecisionsOpen((v) => !v)}
        onOpenSession={onOpenSession}
        showTitle={showTitle}
        gutter={gutter}
      />
      {decisionsOpen && <BoardDecisionStream decisions={data.decisions} touch={touch} />}
      <div data-board-scroll="" style={{
        flex: 1, minHeight: 0, overflowY: 'auto', background: PAPER,
        padding: touch ? '18px 16px 28px' : '24px 28px 32px',
      }}>
        {data.body.kind === 'empty'
          ? <LegacyFiles files={data.body.files} onOpen={openFile} />
          : srcDoc === null
            ? <div style={CENTERED}>{L.boardLoading}</div>
            : <BoardFrame srcDoc={srcDoc} title={board.title} onOpen={openFile} onLink={openLink} />}
      </div>
    </div>
  );
}
