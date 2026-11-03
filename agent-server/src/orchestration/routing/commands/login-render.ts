// How a login flow's notices read in chat: authorization links, device codes and progress, posted
// once each, with progress updated in place.

import { t } from '@core/i18n.js';
import type { LoginFlowNotice } from '@domain/auth/index.js';
import type { Destination, MessageContent, MessageRef, PlatformAdapter, RichBlock } from '@platform/index.js';

export function loginDestination(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel, sessionId: '' };
}

export interface NoticeTracker {
  lastNotice: string | null;
  progressRef: MessageRef | null;
}

function section(text: string): RichBlock {
  return { type: 'section', text, format: 'markdown' };
}

function messageContent(lines: string[], richBlocks?: RichBlock[]): MessageContent {
  const text = lines.join('\n');
  return { text, richBlocks: richBlocks ?? [section(text)] };
}

function renderInfoNotice(notice: Extract<LoginFlowNotice, { kind: 'info' }>): MessageContent {
  const links = (notice.links ?? []).map(link => (
    link.label ? `${link.label}: ${link.url}` : link.url
  ));
  return messageContent([notice.message, ...links]);
}

function renderAuthUrlNotice(
  notice: Extract<LoginFlowNotice, { kind: 'auth_url' }>,
): MessageContent {
  const heading = notice.instructions ?? t('cmd.auth.loginOpenAuthorization');
  return messageContent([heading, notice.url]);
}

function renderDeviceNotice(
  notice: Extract<LoginFlowNotice, { kind: 'device_code' }>,
): MessageContent {
  const code = `*${t('cmd.auth.loginDeviceCode')}*\n\`${notice.userCode}\``;
  const verify = `*${t('cmd.auth.loginVerificationPage')}*\n${notice.verificationUri}`;
  const expiry = notice.expiresInSeconds === undefined
    ? []
    : [t('cmd.auth.loginDeviceExpires', { seconds: notice.expiresInSeconds })];
  return messageContent([code, verify, ...expiry], [section(code), section(verify), ...expiry.map(section)]);
}

function renderProgressNotice(
  notice: Extract<LoginFlowNotice, { kind: 'progress' }>,
): MessageContent {
  return messageContent([t('cmd.auth.loginProgress', { message: notice.message })]);
}

export function renderNotice(notice: LoginFlowNotice): MessageContent {
  if (notice.kind === 'info') return renderInfoNotice(notice);
  if (notice.kind === 'auth_url') return renderAuthUrlNotice(notice);
  if (notice.kind === 'device_code') return renderDeviceNotice(notice);
  return renderProgressNotice(notice);
}

export function noticeKey(notice: LoginFlowNotice | null): string | null {
  return notice ? JSON.stringify(notice) : null;
}

export async function deliverNotice(
  adapter: PlatformAdapter,
  channel: string,
  notice: LoginFlowNotice,
  tracker: NoticeTracker,
): Promise<void> {
  const key = noticeKey(notice);
  if (tracker.lastNotice === key) return;
  tracker.lastNotice = key;
  const content = renderNotice(notice);
  if (notice.kind === 'progress' && tracker.progressRef) {
    await adapter.updateMessage(tracker.progressRef, content);
    return;
  }
  const ref = await adapter.postMessage(loginDestination(channel), content);
  if (notice.kind === 'progress') tracker.progressRef = ref;
}

