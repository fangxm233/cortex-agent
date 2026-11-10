import { t } from '@core/i18n.js';
import type { NoticeAction } from '@core/types/agent-types.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { emitSystemNotice } from './system-notice.js';

/** "Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required." */
const VERSION_REQUIRED = /\bClaude Code v?(\d+\.\d+\.\d+)\b.*?\bversion v?(\d+\.\d+\.\d+)\S* or newer is required/i;
/** Any other wording that still tells the user to update the CLI. */
const RUN_CLAUDE_UPDATE = /\brun\s+['"`]?claude update\b/i;

export interface ClaudeUpdateRequired {
  installed?: string;
  required?: string;
}

/** Whether a backend error says the local Claude Code is too old, with the versions it names. */
export function claudeUpdateRequired(text: string): ClaudeUpdateRequired | null {
  const match = VERSION_REQUIRED.exec(text);
  if (match) return { installed: match[1], required: match[2] };
  return RUN_CLAUDE_UPDATE.test(text) ? {} : null;
}

/** The chat-card action for an error that asks for a Claude Code update. */
export function claudeUpdateNoticeAction(text: string): NoticeAction | undefined {
  const found = claudeUpdateRequired(text);
  if (!found) return undefined;
  return found.required ? { kind: 'update-claude-code', required: found.required } : { kind: 'update-claude-code' };
}

const notified = new Set<string>();

/**
 * Web chats show the update button on the error card itself. Slack, Feishu and runs without a chat
 * get one admin notice per required version instead, so a failing schedule cannot go unnoticed.
 */
export function noticeClaudeUpdateRequired(message: string, channel: string | null | undefined): void {
  if (channel?.startsWith('web:')) return;
  const found = claudeUpdateRequired(message);
  const adapter = jobCtx.adapter;
  if (!found || !adapter) return;
  const key = found.required ?? '';
  if (notified.has(key)) return;
  notified.add(key);
  const text = found.required
    ? t('notify.claudeUpdateRequired.body', { installed: found.installed ?? '?', required: found.required })
    : t('notify.claudeUpdateRequired.bodyGeneric');
  void emitSystemNotice(adapter, { title: t('notify.claudeUpdateRequired.title'), text, level: 'warning' });
}

/** Test-only: forget which versions were already announced. */
export function _resetClaudeUpdateNotices(): void {
  notified.clear();
}
