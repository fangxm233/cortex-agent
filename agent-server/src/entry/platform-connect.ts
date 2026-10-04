import { setTimeout as delay } from 'node:timers/promises';
import { extractTuiAdapter, listPlatformAdapters } from '@platform/index.js';
import type { PlatformAdapter } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { t } from '@core/i18n.js';
import { emitSystemNotice, type SystemNoticeInput } from '@domain/system/system-notice.js';

const log = createLogger('platform');

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const SLOW_CONNECT_MS = 60_000;

export interface PlatformConnectOptions {
  /** Waits between failed attempts; one more attempt than there are delays. */
  retryDelaysMs?: readonly number[];
  /** Warn once when a platform has neither connected nor failed by then. */
  slowConnectMs?: number;
  /** Where connection trouble is reported. Defaults to the system notice (admin channel + Web toast). */
  notify?: (notice: SystemNoticeInput) => void;
}

export interface PlatformConnections {
  /** Settles when every chat platform has connected or given up (never, for one stopped mid-start). */
  readonly settled: Promise<void>;
  /** Cancel pending retries and close the chat platforms, including one still connecting. */
  stop(): Promise<void>;
}

function platformLabel(name: string): string {
  if (name === 'slack') return t('notice.platform.slack');
  if (name === 'feishu') return t('notice.platform.feishu');
  return name;
}

/** Start every platform adapter behind `adapter`. Local listeners (the TUI gateway) are bound before
 *  this resolves; chat platforms connect over the network in the background, because nothing at boot
 *  needs their sockets — outbound posts go through the platforms' HTTP APIs. A platform whose connect
 *  keeps failing is retried a bounded number of times, then reported as an error. One whose SDK keeps
 *  retrying on its own (Slack while the network is down, Feishu for an unknown app) never fails, so it
 *  is reported as a warning once it has been connecting for `slowConnectMs`. */
export async function startPlatformAdapters(
  adapter: PlatformAdapter,
  opts: PlatformConnectOptions = {},
): Promise<PlatformConnections> {
  const tui = extractTuiAdapter(adapter);
  const remote = listPlatformAdapters(adapter).filter((a) => a !== tui);
  if (tui) await tui.start();

  const retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const slowConnectMs = opts.slowConnectMs ?? SLOW_CONNECT_MS;
  const notify = opts.notify ?? ((notice: SystemNoticeInput) => { void emitSystemNotice(adapter, notice); });
  const abort = new AbortController();
  const { signal } = abort;

  async function connect(platform: PlatformAdapter): Promise<void> {
    const startedAt = performance.now();
    const label = platformLabel(platform.name);
    let failures = 0;
    let reportedSlow = false;
    const slow = setTimeout(() => {
      if (signal.aborted || failures > 0) return;
      const seconds = Math.round(slowConnectMs / 1000);
      log.warn(`${platform.name}: still connecting after ${seconds}s`);
      reportedSlow = true;
      notify({ level: 'warning', title: label, text: t('notice.platform.stillConnecting', { platform: label, seconds }) });
    }, slowConnectMs);
    slow.unref();
    try {
      for (;;) {
        try {
          await platform.start();
          // Stopped while the handshake was in flight: the connection it produced belongs to no one.
          if (signal.aborted) { await platform.stop().catch(() => {}); return; }
          log.info(`${platform.name}: connected in ${Math.round(performance.now() - startedAt)}ms`);
          if (reportedSlow) notify({ level: 'info', title: label, text: t('notice.platform.connected', { platform: label }) });
          return;
        } catch (error) {
          if (signal.aborted) return;
          const err = error instanceof Error ? error : new Error(String(error));
          failures += 1;
          if (failures > retryDelays.length) {
            log.error(`${platform.name}: failed to connect after ${failures} attempt${failures === 1 ? '' : 's'}: ${err.message}`);
            notify({ level: 'error', title: label, text: t('notice.platform.connectFailed', { platform: label, error: err.message }) });
            return;
          }
          const wait = retryDelays[failures - 1];
          log.warn(`${platform.name}: failed to connect (attempt ${failures}): ${err.message} — retrying in ${Math.round(wait / 1000)}s`);
          await platform.stop().catch(() => {});
          try { await delay(wait, undefined, { signal, ref: false }); } catch { return; }
        }
      }
    } finally {
      clearTimeout(slow);
    }
  }

  const settled = Promise.all(remote.map(connect)).then(() => {});
  return {
    settled,
    async stop() {
      abort.abort();
      await Promise.allSettled(remote.map((a) => a.stop()));
    },
  };
}
