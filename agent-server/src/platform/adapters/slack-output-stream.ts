import { createLogger } from '@core/log.js';
import type { SlackAdapter } from './slack.js';
import type { OpenOutputStreamOpts } from '../output-stream.js';
import type { Destination } from '../types.js';
import { ChunkedOutputStream, type ChunkedOutputStreamConfig } from './chunked-output-stream.js';

const log = createLogger('slack-output-stream');

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [200, 600, 1500, 4000];
let retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

/**
 * Test-only: override retry delays to skip real wall-clock waits.
 * Pass [] for no retries, [0,0,0,0] to keep 4-attempt retry semantics with no wait.
 * Production code must never call this.
 */
export function _testSetRetryDelays(delays: readonly number[]): void {
  retryDelaysMs = delays;
}

/** Test-only: restore production retry delays. */
export function _testResetRetryDelays(): void {
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
}

// Slack retries a rejected rich message as plain text, records postInteractive
// in the WAL, and marks a failed update's WAL entry sent once its content has
// been re-posted as a new message.
const SLACK_STREAM: ChunkedOutputStreamConfig = {
  name: 'slack-output-stream',
  log,
  retryDelays: () => retryDelaysMs,
  plainTextFallback: true,
  walAroundPostInteractive: true,
  afterSentOnFailedUpdate: true,
};

export class SlackOutputStream extends ChunkedOutputStream {
  constructor(adapter: SlackAdapter, destination: Destination, opts?: OpenOutputStreamOpts) {
    super(adapter, destination, opts, SLACK_STREAM);
  }
}
