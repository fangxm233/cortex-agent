import { t } from '@core/i18n.js';
import { createLogger } from '@core/log.js';
import type { AuthNoticeAction } from '@core/types/agent-types.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import type { AuthErrorKind, CortexEvent, EventBus } from '@events/index.js';
import type { ButtonElement, MessageContent, PlatformAdapter } from '@platform/index.js';
import {
  getAuthStatus,
  preferredAuthType,
  type AuthAccountStatus,
  type AuthStatusSnapshot,
  type AuthType,
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

interface Reminder { notifiedAt: number; attempt: symbol }

/** One reminder per pair and channel every 24h; a null channel (internal run) is its own bucket. */
class ReminderLedger {
  private readonly byPair = new Map<string, Map<string | null, Reminder>>();

  constructor(private readonly now: () => number) {}

  private fresh(reminder: Reminder | undefined): boolean {
    return reminder !== undefined && this.now() - reminder.notifiedAt < REMINDER_INTERVAL_MS;
  }

  anyRecent(pair: string): boolean {
    return [...(this.byPair.get(pair)?.values() ?? [])].some(reminder => this.fresh(reminder));
  }

  /** Reserve before async delivery so concurrent events cannot create a retry storm. */
  reserve(pair: string, channel: string | null): symbol | null {
    const channels = this.byPair.get(pair) ?? new Map<string | null, Reminder>();
    if (this.fresh(channels.get(channel))) return null;
    const attempt = Symbol(pair);
    channels.set(channel, { notifiedAt: this.now(), attempt });
    this.byPair.set(pair, channels);
    return attempt;
  }

  release(pair: string, channel: string | null, attempt: symbol): void {
    const channels = this.byPair.get(pair);
    if (channels?.get(channel)?.attempt === attempt) channels.delete(channel);
  }

  clear(pair: string): void {
    this.byPair.delete(pair);
  }
}

export type WasAuthRecentlyNotified = (
  backend: AuthRequiredEvent['backend'],
  provider: string,
) => boolean;

let recentNotificationQuery: WasAuthRecentlyNotified = () => false;

export function wasAuthRecentlyNotified(
  backend: AuthRequiredEvent['backend'],
  provider: string,
): boolean {
  return recentNotificationQuery(backend, provider);
}

function providerLabel(event: AuthRequiredEvent, account: AuthAccountStatus | null): string {
  if (event.backend === 'claude') return 'Claude';
  return account?.label || event.provider;
}

function buildNotice(
  event: AuthRequiredEvent,
  account: AuthAccountStatus | null,
  actionable: boolean,
): { title: string; text: string } {
  const provider = providerLabel(event, account);
  const guidance = actionable
    ? t('notify.authRequired.guide.action')
    : event.backend === 'claude'
      ? t('notify.authRequired.guide.claude')
      : t('notify.authRequired.guide.pi', { provider });
  return {
    title: t('notify.authRequired.title'),
    text: t('notify.authRequired.body', {
      provider,
      kind: t(AUTH_KIND_KEYS[event.kind]),
      guidance,
    }),
  };
}

async function readSnapshot(
  readStatus: () => Promise<AuthStatusSnapshot>,
): Promise<AuthStatusSnapshot | null> {
  try {
    return await readStatus();
  } catch {
    return null;
  }
}

function findAccount(
  snapshot: AuthStatusSnapshot | null,
  event: AuthRequiredEvent,
): AuthAccountStatus | null {
  return snapshot?.accounts.find(account => (
    account.backend === event.backend && account.provider === event.provider
  )) ?? null;
}

/** The credential that failed, else the one the account runs on, else the preferred login. */
function noticeAuthType(
  event: AuthRequiredEvent,
  account: AuthAccountStatus,
  snapshot: AuthStatusSnapshot,
): AuthType | null {
  const supported = (authType: AuthType | null) => (
    authType && account.capabilities.includes(authType) ? authType : null
  );
  return supported(event.authType) ?? supported(account.authType)
    ?? preferredAuthType(snapshot, event.backend, event.provider);
}

function resolveAction(
  event: AuthRequiredEvent,
  snapshot: AuthStatusSnapshot | null,
): AuthNoticeAction | null {
  const account = findAccount(snapshot, event);
  const authType = account && snapshot ? noticeAuthType(event, account, snapshot) : null;
  if (!authType) return null;
  return {
    kind: 'auth-login',
    noticeId: `${event.backend}:${event.provider}:${event.ts}`,
    backend: event.backend,
    provider: event.provider,
    authType,
  };
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

/** Internal runs have no conversation: the notice and its login button go to the admin channel. */
async function emitAdminNotice(
  adapter: PlatformAdapter,
  notice: { title: string; text: string },
  action: AuthNoticeAction | null,
  buildAction?: AuthWatchDependencies['buildPlatformAction'],
): Promise<void> {
  const button = action && buildAction ? buildAction(action, '', notice.text) : null;
  const { richBlocks } = platformContent(notice.text, button);
  await emitSystemNotice(adapter, { ...notice, level: 'error', richBlocks });
}

async function deliverNotice(
  bus: EventBus,
  adapter: PlatformAdapter,
  event: AuthRequiredEvent,
  dependencies: AuthWatchDependencies,
): Promise<void> {
  const web = event.channel?.startsWith('web:') ?? false;
  const snapshot = await readSnapshot(dependencies.readStatus ?? getAuthStatus);
  const action = resolveAction(event, snapshot);
  // The admin notice's Web toast cannot carry the button, so its text keeps the manual guidance.
  const actionable = !!action && event.channel !== null && (web || !!dependencies.buildPlatformAction);
  const notice = buildNotice(event, findAccount(snapshot, event), actionable);
  if (event.channel === null) {
    await emitAdminNotice(adapter, notice, action, dependencies.buildPlatformAction);
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
  const reminders = new ReminderLedger(dependencies.now ?? Date.now);
  recentNotificationQuery = (backend, provider) => reminders.anyRecent(pairKey({ backend, provider }));
  bus.subscribe('auth.required', (event) => {
    const key = pairKey(event);
    const attempt = reminders.reserve(key, event.channel);
    if (!attempt) return;
    void deliverNotice(bus, adapter, event, dependencies).catch(() => {
      reminders.release(key, event.channel, attempt);
      log.error(`Failed to deliver authentication notice for ${key}`);
    });
  });
  bus.subscribe('auth.recovered', (event) => {
    reminders.clear(pairKey(event));
  });
}
