import { setTimeout as delay } from 'node:timers/promises';
import { extractTuiAdapter, listPlatformAdapters } from '@platform/index.js';
import type { PlatformAdapter } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { t } from '@core/i18n.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';

const log = createLogger('platform');

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const SLOW_CONNECT_MS = 60_000;

export interface PlatformConnectOptions {
  /** Waits between failed attempts; one more attempt than there are delays. */
  retryDelaysMs?: readonly number[];
  /** Warn once when a platform has neither connected nor failed by then. */
  slowConnectMs?: number;
  /** Called once for a platform still unconnected after its last attempt. Defaults to an error notice. */
  onGiveUp?: (platform: string, error: Error) => void;
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
 *  keeps failing is retried a bounded number of times, then reported through `onGiveUp`. */
export async function startPlatformAdapters(
  adapter: PlatformAdapter,
  opts: PlatformConnectOptions = {},
): Promise<PlatformConnections> {
  const tui = extractTuiAdapter(adapter);
  const remote = listPlatformAdapters(adapter).filter((a) => a !== tui);
  if (tui) await tui.start();

  const retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const slowConnectMs = opts.slowConnectMs ?? SLOW_CONNECT_MS;
  const onGiveUp = opts.onGiveUp ?? ((platform: string, error: Error) => {
    void emitSystemNotice(adapter, {
      level: 'error',
      title: platformLabel(platform),
      text: t('notice.platform.connectFailed', { platform: platformLabel(platform), error: error.message }),
    });
  });
  const abort = new AbortController();
  const { signal } = abort;

  async function connect(platform: PlatformAdapter): Promise<void> {
    const startedAt = performance.now();
    let failures = 0;
    const slow = setTimeout(() => {
      if (!signal.aborted && failures === 0) log.warn(`${platform.name}: still connecting after ${Math.round(slowConnectMs / 1000)}s`);
    }, slowConnectMs);
    slow.unref();
    try {
      for (;;) {
        try {
          await platform.start();
          // Stopped while the handshake was in flight: the connection it produced belongs to no one.
          if (signal.aborted) { await platform.stop().catch(() => {}); return; }
          log.info(`${platform.name}: connected in ${Math.round(performance.now() - startedAt)}ms`);
          return;
        } catch (error) {
          if (signal.aborted) return;
          const err = error instanceof Error ? error : new Error(String(error));
          failures += 1;
          if (failures > retryDelays.length) {
            log.error(`${platform.name}: failed to connect after ${failures} attempt${failures === 1 ? '' : 's'}: ${err.message}`);
            onGiveUp(platform.name, err);
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
