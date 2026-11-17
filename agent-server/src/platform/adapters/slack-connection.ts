import { App, LogLevel, SocketModeReceiver, type Logger as BoltLogger } from '@slack/bolt';
import { ConsoleLogger } from '@slack/logger';
import { ErrorCode, type WebClientOptions } from '@slack/web-api';
import { createLogger } from '@core/log.js';

const log = createLogger('slack');

/** Emitted by patches/@slack__socket-mode@2.0.7.patch when an automatic reconnect ends without a
 *  connection while the client is not shutting down. socket-mode makes no further attempt after it. */
const RECONNECT_FAILED = 'reconnect_failed';
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** About 20 minutes into an outage at the default delays. */
const ERROR_AFTER_ATTEMPTS = 10;

/** Errors socket-mode treats as unrecoverable when it fetches a socket URL. */
const AUTH_ERRORS = new Set(['not_authed', 'invalid_auth', 'account_inactive', 'user_removed_from_team', 'team_disabled']);

interface SlackApiError {
  code?: string;
  message?: string;
  data?: { error?: string };
}

const REASON_BY_CODE: Record<string, (error: SlackApiError) => string> = {
  [ErrorCode.PlatformError]: (error) => {
    const code = error.data?.error ?? 'unknown';
    return AUTH_ERRORS.has(code) ? `auth error: ${code}` : `Slack API error: ${code}`;
  },
  [ErrorCode.RequestError]: (error) => `network error: ${error.message}`,
  [ErrorCode.HTTPError]: (error) => `network error: ${error.message}`,
};

function describeFailure(error: unknown): string {
  const describe = REASON_BY_CODE[(error as SlackApiError | undefined)?.code ?? ''];
  if (describe) return describe(error as SlackApiError);
  return error instanceof Error ? error.message : String(error);
}

function formatDelay(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

export interface SlackConnectionConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
}

/** Test hooks: a local Slack API, faster socket-mode timers and backoff, a quiet Bolt logger. */
export interface SlackConnectionTuning {
  slackApiUrl?: string;
  clientPingTimeout?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  logger?: BoltLogger;
}

function boltConsoleLogger(): BoltLogger {
  const logger = new ConsoleLogger();
  logger.setName('bolt-app');
  return logger;
}

/** The App Bolt builds for `socketMode: true`, with the receiver built here so its client is reachable.
 *  socket-mode's own apps.connections.open retries keep its defaults, with the wait between them
 *  capped and a hung request cut off. Initialization is deferred to start(): an App built with a
 *  token runs auth.test in its constructor and keeps a failure (offline at boot) as an unhandled
 *  rejection that every later event's authorization replays. */
function buildSocketApp(config: SlackConnectionConfig, tuning: SlackConnectionTuning) {
  const logger = tuning.logger ?? boltConsoleLogger();
  const apiUrl: WebClientOptions = tuning.slackApiUrl ? { slackApiUrl: tuning.slackApiUrl } : {};
  const socketApi: WebClientOptions = {
    ...apiUrl,
    logger,
    timeout: 30_000,
    retryConfig: { retries: 100, factor: 1.3, maxTimeout: MAX_RETRY_DELAY_MS },
  };
  const receiver = new SocketModeReceiver({
    appToken: config.appToken,
    logger: tuning.logger,
    logLevel: LogLevel.INFO,
    clientPingTimeout: tuning.clientPingTimeout,
    installerOptions: { clientOptions: socketApi },
  });
  const app = new App({
    token: config.botToken,
    signingSecret: config.signingSecret,
    socketMode: true,
    receiver,
    logger,
    clientOptions: { ...apiUrl },
    deferInitialization: true,
  });
  return { app, client: receiver.client };
}

/** The Slack socket-mode connection. socket-mode reconnects on its own after drops; when one of its
 *  reconnects fails for good, this restarts the App with capped exponential backoff until stop(). */
export class SlackConnection {
  readonly app: App;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private active = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private initialized = false;

  constructor(config: SlackConnectionConfig, tuning: SlackConnectionTuning = {}) {
    const { app, client } = buildSocketApp(config, tuning);
    this.app = app;
    this.retryDelayMs = tuning.retryDelayMs ?? RETRY_DELAY_MS;
    this.maxRetryDelayMs = tuning.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    client.on('connected', () => this.onConnected());
    client.on(RECONNECT_FAILED, (error: unknown) => this.scheduleRetry(error));
  }

  get retryPending(): boolean {
    return this.retryTimer !== null;
  }

  /** Rejects when auth.test fails (after the Web API client's own retries); start() again to retry. */
  async start(): Promise<void> {
    this.active = true;
    if (!this.initialized) {
      await this.app.init();
      this.initialized = true;
      if (!this.active) return;
    }
    await this.app.start();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.attempts = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.app.stop();
  }

  private onConnected(): void {
    if (this.attempts > 0) log.info(`Slack reconnected after ${this.attempts} attempt${this.attempts === 1 ? '' : 's'}`);
    this.attempts = 0;
  }

  /** Runs only once the client holds neither a socket nor a timer of its own (socket-mode gave up,
   *  or a restart's URL fetch failed), so a restart never overlaps another connect. */
  private scheduleRetry(error: unknown): void {
    if (!this.active || this.retryTimer) return;
    const delay = Math.min(this.retryDelayMs * 2 ** this.attempts, this.maxRetryDelayMs);
    this.attempts += 1;
    const reason = describeFailure(error);
    log.warn(`Slack connection lost (${reason}); reconnecting in ${formatDelay(delay)} (attempt ${this.attempts})`);
    if (this.attempts === ERROR_AFTER_ATTEMPTS) {
      log.error(`Slack still disconnected after ${this.attempts - 1} reconnect attempts: ${reason}`);
    }
    this.retryTimer = setTimeout(() => this.retry(), delay);
    this.retryTimer.unref();
  }

  private retry(): void {
    this.retryTimer = null;
    this.app.start().catch((error: unknown) => this.scheduleRetry(error));
  }
}
