// input:  React, mobile kit, presentation props
// output: MMemoryFileView
// pos:    Mobile MemoryFileView presentation
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
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
      style={{ height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}
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
                font: `400 11px ${MONO}`,
                color: MC.muted,
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
          <div style={{ padding: 16, font: `400 12px ${MONO}`, color: MC.muted }}>{copy.loading}</div>
        )}
        {status === 'error' && (
          <div style={{ padding: 16, fontSize: 12.5, color: MC.fail }}>{copy.error}</div>
        )}
        {status === 'empty' && (
          <div style={{ padding: 16, font: `400 12px ${MONO}`, color: MC.muted }}>{copy.empty}</div>
        )}
        {status === 'ready' && (
          <div
            style={{
              padding: '16px 18px calc(28px + env(safe-area-inset-bottom))',
              fontSize: 13,
              lineHeight: 1.7,
              color: MC.body,
              minWidth: 0,
              overflowWrap: 'anywhere',
            }}
          >
            <ChatMarkdown text={content} />
          </div>
        )}
      </div>
    </div>
  );
}
