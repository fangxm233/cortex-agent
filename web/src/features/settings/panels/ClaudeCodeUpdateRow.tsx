import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { SButton, SRow } from '@/features/settings/ui/settings-ui';
import { claudeCodeBehind, claudeCodeFailureText, claudeCodeSummary } from '@/features/claude-code-update/claude-code-vm';
import { useClaudeCodeUpdate, type ClaudeCodeUpdate } from '@/features/claude-code-update/useClaudeCodeUpdate';

const CONTROLS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const ALERT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--proto-danger)', marginTop: 6 };
const DETAIL_STYLE: CSSProperties = {
  margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--proto-muted-2)',
  fontFamily: "'IBM Plex Mono',monospace", whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
};

export function ClaudeCodeUpdateRowView({ controller }: { controller: ClaudeCodeUpdate }) {
  const L = useVocab();
  const { status, busy } = controller;
  const failure = status && status.installed ? claudeCodeFailureText(status, L) : null;
  return (
    <SRow
      data-claude-code-update={status?.state ?? 'loading'}
      title={L.claudeCodeTitle}
      desc={claudeCodeSummary(status, L)}
      control={(
        <div style={CONTROLS_STYLE}>
          <SButton tone="neutral" disabled={busy} data-claude-code-check="" onClick={controller.check}>
            {L.claudeCodeCheck}
          </SButton>
          {claudeCodeBehind(status) || status?.state === 'updating' ? (
            <SButton tone="primary" disabled={busy} data-claude-code-apply="" onClick={controller.update}>
              {L.claudeCodeUpdate}
            </SButton>
          ) : null}
        </div>
      )}
    >
      {failure ? <div role="alert" style={ALERT_STYLE}>{failure}</div> : null}
      {status?.state === 'failed' && status.detail ? <pre style={DETAIL_STYLE}>{status.detail}</pre> : null}
    </SRow>
  );
}

/** Settings → Advanced → Updates: the server's local Claude Code version and its update. */
export function ClaudeCodeUpdateRow() {
  return <ClaudeCodeUpdateRowView controller={useClaudeCodeUpdate({ autoCheck: true })} />;
}
