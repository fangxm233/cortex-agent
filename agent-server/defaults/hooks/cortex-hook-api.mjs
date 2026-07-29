// @cortex-hook-version 2026.7.29
// input:  node:http, hook env (WEBHOOK_PORT/CORTEX_WEBHOOK_TOKEN/CORTEX_HOOK_CHANNEL/...)
// output: askUser() — blocking ask-user card on the session's message platform
// pos:    Helper library imported by hook scripts (not a hook entry itself)
// >>> If I am updated, be sure to update my header comment and the CORTEX.md in the same folder <<<

import http from 'node:http';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // client guard; the server bridge TTL (30 min) fires first

/** Normalize 'warn' to 'warning'; throw on anything outside info/warning/error. */
function resolveLevel(level) {
  const normalized = level === 'warn' ? 'warning' : level;
  if (normalized !== 'info' && normalized !== 'warning' && normalized !== 'error') {
    throw new Error(`askUser: invalid level '${level}' (valid: info, warn, warning, error)`);
  }
  return normalized;
}

function postJson(path, payload, timeoutMs) {
  const port = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-cortex-token': process.env.CORTEX_WEBHOOK_TOKEN || '',
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`askUser: invalid webhook response: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('askUser: webhook request timed out')); });
    req.write(body);
    req.end();
  });
}

/**
 * Post an ask-user-question card to the session's message platform (Slack / Feishu / Web UI)
 * and BLOCK until the user answers or the server bridge TTL (30 min) expires.
 *
 * @param {object}   opts
 * @param {Array}    opts.questions  1-4 items: { question, header?, options?: [{label, description?}], multiSelect? }
 * @param {string=}  opts.level      'info' | 'warn' | 'warning' | 'error' — card severity (omit for neutral)
 * @param {string=}  opts.channel    conduit id; defaults to CORTEX_HOOK_CHANNEL → SLACK_CHANNEL
 * @param {string=}  opts.sessionId  session to resolve the channel from; defaults to CORTEX_HOOK_SESSION_ID
 * @param {string=}  opts.threadId   defaults to CORTEX_THREAD_ID
 * @param {number=}  opts.timeoutMs  client-side HTTP guard (default 60 min)
 * @param {boolean=} opts.dryRun     smoke-test path: journal the event, resolve synthetically
 * @returns {Promise<{answers: Record<string,string>, error?: string}>}
 *          error codes: 'timeout' | 'post_failed' | 'bus_not_initialized'
 */
export async function askUser(opts = {}) {
  const { questions, level, timeoutMs, dryRun } = opts;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('askUser: questions[] is required');
  }
  const channel = opts.channel ?? process.env.CORTEX_HOOK_CHANNEL ?? process.env.SLACK_CHANNEL ?? null;
  const sessionId = opts.sessionId ?? process.env.CORTEX_HOOK_SESSION_ID ?? null;
  if (!channel && !sessionId) {
    throw new Error('askUser: no route — pass {channel} or {sessionId}, or run under a hook env (CORTEX_HOOK_CHANNEL / SLACK_CHANNEL / CORTEX_HOOK_SESSION_ID)');
  }
  const body = {
    ...(channel ? { channel } : {}),
    ...(sessionId ? { sessionId } : {}),
    threadId: opts.threadId ?? process.env.CORTEX_THREAD_ID ?? null,
    questions,
    ...(level !== undefined ? { level: resolveLevel(level) } : {}),
    ...(dryRun === true ? { dryRun: true } : {}),
  };
  return postJson('/hook/ask-user-question', body, timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
