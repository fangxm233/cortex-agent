// input:  auth events, capability snapshot, PlatformAdapter, i18n
// output: retryable channel auth notices with process-local debounce
// pos:    Authentication-required notification subscriber
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import type { AuthNoticeAction } from '@core/types/agent-types.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import type { AuthErrorKind, CortexEvent, EventBus } from '@events/index.js';
import type { ButtonElement, MessageContent, PlatformAdapter } from '@platform/index.js';
import {
  getAuthStatus,
  preferredAuthType,
  type AuthStatusSnapshot,
} from './auth-status.js';

const log = createLogger('auth-watch');
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

type AuthRequiredEvent = Extract<CortexEvent, { type: 'auth.required' }>;

type AuthKindKey =
  | 'notify.authRequired.kind.loginRequired'
  | 'notify.authRequired.kind.oauthExpired'
  | 'notify.authRequired.kind.invalidApiKey'
  | 'notify.authRequired.kind.unauthorized'
  | 'notify.authRequired.kind.invalidGrant';

const AUTH_KIND_KEYS: Record<AuthErrorKind, AuthKindKey> = {
  login_required: 'notify.authRequired.kind.loginRequired',
  oauth_expired: 'notify.authRequired.kind.oauthExpired',
  invalid_api_key: 'notify.authRequired.kind.invalidApiKey',
  unauthorized: 'notify.authRequired.kind.unauthorized',
  invalid_grant: 'notify.authRequired.kind.invalidGrant',
};

export interface AuthWatchDependencies {
  now?: () => number;
  readStatus?: () => Promise<AuthStatusSnapshot>;
  buildPlatformAction?: (
    action: AuthNoticeAction,
    channel: string,
    noticeText: string,
  ) => ButtonElement;
}

function pairKey(event: { backend: string; provider: string }): string {
  return `${event.backend}:${event.provider}`;
}

function buildNotice(
  event: AuthRequiredEvent,
  actionable: boolean,
): { title: string; text: string } {
  const guidance = actionable
    ? t('notify.authRequired.guide.action')
    : event.backend === 'claude'
      ? t('notify.authRequired.guide.claude')
      : t('notify.authRequired.guide.pi', { provider: event.provider });
  return {
    title: t('notify.authRequired.title'),
    text: t('notify.authRequired.body', {
      backend: event.backend,
      provider: event.provider,
      kind: t(AUTH_KIND_KEYS[event.kind]),
      guidance,
    }),
  };
}

async function resolveAction(
  event: AuthRequiredEvent,
  readStatus: () => Promise<AuthStatusSnapshot>,
): Promise<AuthNoticeAction | null> {
  try {
    const authType = preferredAuthType(await readStatus(), event.backend, event.provider);
    if (!authType) return null;
    return {
      kind: 'auth-login',
      noticeId: `${event.backend}:${event.provider}:${event.ts}`,
      backend: event.backend,
      provider: event.provider,
      authType,
    };
  } catch {
    return null;
  }
}

function platformContent(text: string, button: ButtonElement | null): MessageContent {
  const richBlocks: MessageContent['richBlocks'] = [
    { type: 'section', text, format: 'markdown' },
  ];
  if (button) richBlocks.push({ type: 'actions', elements: [button] });
  return { text, richBlocks };
}

function publishWebNotice(
  bus: EventBus,
  event: AuthRequiredEvent & { channel: string },
  text: string,
  action: AuthNoticeAction | null,
): void {
  bus.publish({
    type: 'session.message', sessionId: event.channel.slice(4), channel: event.channel,
    role: 'assistant', text, noticeLevel: 'error',
    ...(action ? { authAction: action } : {}),
  });
}

async function postPlatformNotice(
  adapter: PlatformAdapter,
  event: AuthRequiredEvent & { channel: string },
  text: string,
  action: AuthNoticeAction | null,
  buildAction?: AuthWatchDependencies['buildPlatformAction'],
): Promise<void> {
  const button = action && buildAction ? buildAction(action, event.channel, text) : null;
  await adapter.postMessage({
    type: 'interactive-reply', conduit: event.channel,
    ...(event.sessionId !== null ? { sessionId: event.sessionId } : {}),
  }, platformContent(text, button));
}

async function deliverNotice(
  bus: EventBus,
  adapter: PlatformAdapter,
  event: AuthRequiredEvent,
  dependencies: AuthWatchDependencies,
): Promise<void> {
  const web = event.channel?.startsWith('web:') ?? false;
  const actionableNotice = buildNotice(event, true);
  const fallbackNotice = buildNotice(event, false);
  const action = event.channel
    ? await resolveAction(event, dependencies.readStatus ?? getAuthStatus)
    : null;
  const actionable = !!action && (web || !!dependencies.buildPlatformAction);
  const notice = actionable ? actionableNotice : fallbackNotice;
  if (event.channel === null) {
    await emitSystemNotice(adapter, { ...notice, level: 'error' });
  } else if (web) {
    publishWebNotice(bus, event as AuthRequiredEvent & { channel: string }, notice.text, action);
  } else {
    await postPlatformNotice(
      adapter, event as AuthRequiredEvent & { channel: string }, notice.text,
      action, dependencies.buildPlatformAction,
    );
  }
}

export function registerAuthWatch(
  bus: EventBus,
  adapter: PlatformAdapter,
  dependencies: AuthWatchDependencies = {},
): void {
  // A restart may repeat one reminder; keeping this local avoids shared mutable publisher state.
  const reminders = new Map<string, { notifiedAt: number; attempt: symbol }>();
  const now = dependencies.now ?? Date.now;
  bus.subscribe('auth.required', (event) => {
    const key = pairKey(event);
    const current = now();
    const previous = reminders.get(key)?.notifiedAt;
    if (previous !== undefined && current - previous < REMINDER_INTERVAL_MS) return;
    // Reserve before async delivery so concurrent events cannot create a retry storm.
    const attempt = Symbol(key);
    reminders.set(key, { notifiedAt: current, attempt });
    void deliverNotice(bus, adapter, event, dependencies).catch(() => {
      if (reminders.get(key)?.attempt === attempt) reminders.delete(key);
      log.error(`Failed to deliver authentication notice for ${key}`);
    });
  });
  bus.subscribe('auth.recovered', (event) => {
    reminders.delete(pairKey(event));
  });
}
