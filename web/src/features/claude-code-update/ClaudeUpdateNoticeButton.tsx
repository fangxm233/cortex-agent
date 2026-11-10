import { useState, type CSSProperties } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { noticeButtonState } from './claude-code-vm';
import { useClaudeCodeUpdate } from './useClaudeCodeUpdate';

/** The update offered on a chat error card that says the local Claude Code is too old. */
export function ClaudeUpdateNoticeButton({ required, style }: { required?: string; style: (disabled: boolean) => CSSProperties }) {
  const L = useVocab();
  const controller = useClaudeCodeUpdate();
  const [requested, setRequested] = useState(false);
  const state = noticeButtonState({ status: controller.status, required, requested, busy: controller.busy }, L);
  const onClick = () => {
    setRequested(true);
    controller.update();
  };
  return (
    <button
      type="button" className={MENU_FOCUS} data-notice-action="update-claude-code"
      disabled={state.disabled} title={state.title} onClick={onClick} style={style(state.disabled)}
    >
      {state.label}
    </button>
  );
}
