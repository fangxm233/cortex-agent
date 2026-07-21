// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1j)
//
// Mobile 项目记忆 file viewer (/m/memory/file) — a read-only reading surface for one memory file,
// drilled from the 1j memory tree. NON-Tab drill page (the shell hides the Tab bar for /m/memory*).
// Pure presentational (render-testable without tRPC providers); the container (MMemoryFileScreen) reads
// `?path=` + binds `memory.file`. Renders the raw markdown via the shared `ChatMarkdown` (the same
// renderer the 6b plan-read page uses). Git diff/blame is intentionally OMITTED here — the desktop 7b
// viewer owns that richer view; on mobile this is a clean read.
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { MDrillHeader, MC, MONO } from '@/mobile/ui/kit';

export interface MMemoryFileCopy {
  loading: string;
  error: string;
  empty: string;
}

export type MMemoryFileStatus = 'loading' | 'error' | 'ready' | 'empty';

export function MMemoryFileView({
  basename,
  metaLine,
  content,
  status,
  copy,
  onBack,
}: {
  basename: string;
  metaLine: string;
  content: string;
  status: MMemoryFileStatus;
  copy: MMemoryFileCopy;
  onBack: () => void;
}) {
  return (
    <div
      data-screen-label="1j 项目记忆 · 文件"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: MC.canvas }}
    >
      <MDrillHeader onBack={onBack}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              font: `600 14px ${MONO}`,
              color: MC.ink,
              letterSpacing: '-.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {basename}
          </div>
          {metaLine && (
            <div
              style={{
                font: `400 10px ${MONO}`,
                color: MC.faint,
                marginTop: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {metaLine}
            </div>
          )}
        </div>
      </MDrillHeader>

      {/* white reading surface — real file markdown (read-only) */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--proto-card)' }}>
        {status === 'loading' && (
          <div style={{ padding: 16, font: `400 12px ${MONO}`, color: MC.faint }}>{copy.loading}</div>
        )}
        {status === 'error' && (
          <div style={{ padding: 16, fontSize: 12.5, color: MC.fail }}>{copy.error}</div>
        )}
        {status === 'empty' && (
          <div style={{ padding: 16, font: `400 12px ${MONO}`, color: MC.faint }}>{copy.empty}</div>
        )}
        {status === 'ready' && (
          <div
            style={{
              padding: '16px 18px calc(28px + env(safe-area-inset-bottom))',
              fontSize: 13,
              lineHeight: 1.7,
              color: MC.body,
            }}
          >
            <ChatMarkdown text={content} />
          </div>
        )}
      </div>
    </div>
  );
}
