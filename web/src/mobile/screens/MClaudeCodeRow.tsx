import { useVocab } from '@/i18n';
import { MButton } from '@/mobile/ui/kit';
import {
  claudeCodeBehind, claudeCodeFailureText, claudeCodeSummary,
} from '@/features/claude-code-update/claude-code-vm';
import { useClaudeCodeUpdate } from '@/features/claude-code-update/useClaudeCodeUpdate';
import { MSettingsRow } from './MSettingsControls';

/** Mobile twin of the desktop Settings row: the server's Claude Code version and its update. */
export function MClaudeCodeRow() {
  const L = useVocab();
  const { status, busy, check, update } = useClaudeCodeUpdate({ autoCheck: true });
  const failure = status?.installed ? claudeCodeFailureText(status, L) : null;
  const sub = failure ? `${claudeCodeSummary(status, L)} · ${failure}` : claudeCodeSummary(status, L);
  const offerUpdate = claudeCodeBehind(status) || status?.state === 'updating';
  return (
    <MSettingsRow
      dataKey="claude-code" title={L.claudeCodeTitle} sub={sub}
      trailing={(
        <MButton compact variant={offerUpdate ? 'ink' : 'outline'} disabled={busy}
          onClick={offerUpdate ? update : check}>
          {offerUpdate ? L.claudeCodeUpdate : L.claudeCodeCheck}
        </MButton>
      )}
    />
  );
}
