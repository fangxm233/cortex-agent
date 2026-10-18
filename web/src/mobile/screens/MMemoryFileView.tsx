import { ChatMarkdown } from '@/design/ChatMarkdown';
import { useVocabOptional } from '@/i18n';
import { MDrillHeader, MC } from '@/mobile/ui/kit';

export type MMemoryFileStatus = 'loading' | 'error' | 'ready' | 'empty';

export function MMemoryFileView({
  basename,
  metaLine,
  content,
  status,
  onBack,
}: {
  basename: string;
  metaLine: string;
  content: string;
  status: MMemoryFileStatus;
  onBack: () => void;
}) {
  const copy = useVocabOptional();
  return (
    <div
      data-screen-label="1j memory file"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}
    >
      <MDrillHeader onBack={onBack}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 15.5,
              fontWeight: 620,
              color: MC.ink,
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
                fontSize: 12.5,
                color: MC.muted,
                marginTop: 1,
                fontVariantNumeric: 'tabular-nums',
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
          <div style={{ padding: 16, fontSize: 13, color: MC.muted }}>{copy.memLoadingFile}</div>
        )}
        {status === 'error' && (
          <div style={{ padding: 16, fontSize: 12.5, color: MC.fail }}>{copy.memFileReadError}</div>
        )}
        {status === 'empty' && (
          <div style={{ padding: 16, fontSize: 13, color: MC.muted }}>{copy.memFileEmpty}</div>
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
