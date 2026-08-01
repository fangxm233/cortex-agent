// input:  auth lifecycle events, PlatformAdapter, i18n notices
// output: channel auth notices with process-local debounce
// pos:    Authentication-required notification subscriber
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import type { AuthErrorKind, CortexEvent, EventBus } from '@events/index.js';
import type { PlatformAdapter } from '@platform/index.js';

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

function pairKey(event: { backend: string; provider: string }): string {
  return `${event.backend}:${event.provider}`;
}

function buildNotice(event: AuthRequiredEvent): { title: string; text: string } {
  const guidance = event.backend === 'claude'
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

async function deliverNotice(
  bus: EventBus,
  adapter: PlatformAdapter,
  event: AuthRequiredEvent,
): Promise<void> {
  const notice = buildNotice(event);
  if (event.channel === null) {
    await emitSystemNotice(adapter, { ...notice, level: 'error' });
    return;
  }
  if (event.channel.startsWith('web:')) {
    bus.publish({
      type: 'session.message',
      sessionId: event.channel.slice(4),
      channel: event.channel,
      role: 'assistant',
      text: notice.text,
      noticeLevel: 'error',
    });
    return;
  }
  // Feishu renders postMessage content as an inline card; all other conduits follow Slack routing.
  await adapter.postMessage({
    type: 'interactive-reply',
    conduit: event.channel,
    ...(event.sessionId !== null ? { sessionId: event.sessionId } : {}),
  }, { text: notice.text });
}

export function registerAuthWatch(
  bus: EventBus,
  adapter: PlatformAdapter,
  now: () => number = Date.now,
): void {
  // P1 intentionally keeps debounce state in memory: a restart may repeat one reminder, while
  // avoiding persistence or shared mutable state between the event publisher and this subscriber.
  const lastNotificationAt = new Map<string, number>();
  bus.subscribe('auth.required', (event) => {
    const key = pairKey(event);
    const current = now();
    const previous = lastNotificationAt.get(key);
    if (previous !== undefined && current - previous < REMINDER_INTERVAL_MS) return;
    // Record before delivery so concurrent events and a failing adapter cannot create a retry storm.
    lastNotificationAt.set(key, current);
    void deliverNotice(bus, adapter, event).catch(() => {
      log.error(`Failed to deliver authentication notice for ${key}`);
    });
  });
  bus.subscribe('auth.recovered', (event) => {
    lastNotificationAt.delete(pairKey(event));
  });
}
