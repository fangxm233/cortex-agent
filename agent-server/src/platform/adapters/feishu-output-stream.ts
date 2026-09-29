import { createLogger } from '@core/log.js';
import type { FeishuAdapter } from './feishu.js';
import type { OpenOutputStreamOpts } from '../output-stream.js';
import type { Destination } from '../types.js';
import { ChunkedOutputStream, type ChunkedOutputStreamConfig } from './chunked-output-stream.js';

const log = createLogger('feishu-output-stream');

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [200, 600, 1500];
let retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

/** Test-only: override retry delays to skip real wall-clock waits. */
export function _testSetRetryDelays(delays: readonly number[]): void {
  retryDelaysMs = delays;
}

/** Test-only: restore production retry delays. */
export function _testResetRetryDelays(): void {
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
}

// Feishu cards: no plain-text fallback, postInteractive bypasses the WAL, and a
// failed update's WAL entry is not marked sent. Overflow chunks thread under the
// first message; FeishuAdapter.replyInThread sets reply_in_thread.
const FEISHU_STREAM: ChunkedOutputStreamConfig = {
  name: 'feishu-output-stream',
  log,
  retryDelays: () => retryDelaysMs,
  plainTextFallback: false,
  walAroundPostInteractive: false,
  afterSentOnFailedUpdate: false,
};

export class FeishuOutputStream extends ChunkedOutputStream {
  constructor(adapter: FeishuAdapter, destination: Destination, opts?: OpenOutputStreamOpts) {
    super(adapter, destination, opts, FEISHU_STREAM);
  }
}
