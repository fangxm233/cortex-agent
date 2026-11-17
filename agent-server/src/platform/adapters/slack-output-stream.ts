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

/** chat.update refuses text over 4,000 with msg_too_long (chat.postMessage takes far more). Slack
 *  counts UTF-8 bytes after escaping &, < and > and turning emoji into :shortcodes: (checked against
 *  the live API, 2026-11: 1,333 CJK characters pass and 1,334 fail; 223 ✅ fail as
 *  :white_check_mark:). An emoji is charged a long shortcode's length. */
const SLACK_UPDATE_MAX = 4000;
const EMOJI_COST = 32;
const EMOJI = /\p{Extended_Pictographic}/u;

export function slackUpdateCost(text: string): number {
  let cost = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) cost += ch === '&' ? 5 : ch === '<' || ch === '>' ? 4 : 1;
    else if (EMOJI.test(ch)) cost += EMOJI_COST;
    else cost += code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return cost;
}

function isMsgTooLong(error: unknown): boolean {
  return (error as { data?: { error?: string } } | null)?.data?.error === 'msg_too_long';
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
  fitsUpdate: (text) => slackUpdateCost(text) <= SLACK_UPDATE_MAX,
  isPermanent: isMsgTooLong,
};

export class SlackOutputStream extends ChunkedOutputStream {
  constructor(adapter: SlackAdapter, destination: Destination, opts?: OpenOutputStreamOpts) {
    super(adapter, destination, opts, SLACK_STREAM);
  }
}
