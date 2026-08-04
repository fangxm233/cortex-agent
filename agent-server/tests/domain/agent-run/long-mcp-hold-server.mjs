// input:  argv hold/progress budget, observation file paths
// output: a real stdio MCP server whose thread_run call blocks for a chosen duration
// pos:    Fake benchmark MCP server for the long-call proving suite
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// The one component design §13 (13.6) T15 permits to be fake: the server holding the call. Both the
// transport and the SDK request machinery on either side of it are real, so a client that fails to
// raise its per-call budget hits a genuine SDK timeout here rather than a simulated one.

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const holdMs = Number(flag('hold-ms', '65000'));
const progressMs = Number(flag('progress-ms', '0'));
const pidFile = flag('pid-file', undefined);
const startedFile = flag('started-file', undefined);
const abortedFile = flag('aborted-file', undefined);
// Reproduces `benchmark-thread-server.ts`'s own `process.exit(1)`: a sidecar may die mid-call, and
// design §4.6 requires that to be harmless rather than a shortcut through finalization.
const exitAfterMs = Number(flag('exit-after-ms', '0'));
const exitCode = Number(flag('exit-code', '1'));

function record(file, payload) {
  if (file) fs.writeFileSync(file, JSON.stringify(payload));
}

/** Mirrors the shape of the production heartbeat: progress only when the client asked for it. */
function startProgress(extra) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || progressMs <= 0) return () => {};
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    void extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress, message: 'thread_run in progress' },
    }).catch(() => {});
  }, progressMs);
  return () => clearInterval(timer);
}

function holdUntil(signal, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('held'), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      record(abortedFile, { abortedAtEpochMs: Date.now() });
      resolve('aborted');
    }, { once: true });
  });
}

const server = new McpServer({ name: 'cortex-benchmark-thread', version: '0.0.0-fixture' });

server.registerTool('thread_run', {
  description: 'Hold one call for the configured duration, then answer.',
  inputSchema: { handoff: z.string().optional() },
}, async (_input, extra) => {
  record(startedFile, { startedAtEpochMs: Date.now(), pid: process.pid });
  if (exitAfterMs > 0) setTimeout(() => process.exit(exitCode), exitAfterMs);
  const stopProgress = startProgress(extra);
  try {
    const outcome = await holdUntil(extra.signal, holdMs);
    return { content: [{ type: 'text', text: JSON.stringify({ outcome, holdMs }) }] };
  } finally {
    stopProgress();
  }
});

record(pidFile, { pid: process.pid });
await server.connect(new StdioServerTransport());
