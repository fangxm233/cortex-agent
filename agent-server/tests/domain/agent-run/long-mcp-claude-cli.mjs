// input:  the trial argv and the pinned trial environment
// output: one stream-json turn that first holds a real MCP tool call
// pos:    Claude-shaped backend stand-in for the long-MCP-call proving suite
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// A stand-in for the Claude CLI on exactly one axis: it owns the MCP client, and it takes its
// per-call budget from `MCP_TOOL_TIMEOUT` in its own environment, defaulting to the value the
// capability entry records for claude 2.1.220 when the variable is unset. Everything the SDK does
// with that budget is real, so what this fixture measures is the budget Cortex actually supplied.

import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** capabilities.ts: with `MCP_TOOL_TIMEOUT` unset the CLI's per-call hard timeout is 1e8 ms. */
const UNSET_MCP_TOOL_TIMEOUT_MS = 1e8;
/** Long enough for the issued request to reach the sidecar and for it to start holding. */
const DETACH_SETTLE_MS = 400;

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** `/proc/<pid>/stat` field 5 (`pgrp`), read from after the comm field's closing paren. */
function processGroup() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
}

const argv = process.argv.slice(2);
const observationFile = argValue(argv, '--cortex-observation');
const resultFile = argValue(argv, '--cortex-mcp-result');
// `--cortex-detach-mcp` answers the turn while the tool call is still in flight, which leaves the
// sidecar alive at turn end — the case design §4.6 says containment, not the transport, must settle.
const detach = argv.includes('--cortex-detach-mcp');

fs.writeFileSync(observationFile, JSON.stringify({
  env: process.env, argv, pid: process.pid, ppid: process.ppid, pgid: processGroup(),
  cwd: process.cwd(),
}));

const configuredTimeout = Number(process.env.MCP_TOOL_TIMEOUT);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : UNSET_MCP_TOOL_TIMEOUT_MS;

/** Connects, issues the call, and hands back the still-pending request. */
async function issueToolCall() {
  const config = JSON.parse(fs.readFileSync(argValue(argv, '--mcp-config'), 'utf8'));
  const entry = config.mcpServers['cortex-benchmark-thread'];
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args });
  const client = new Client({ name: 'long-mcp-claude-cli', version: '0.0.0-fixture' });
  const startedAtEpochMs = Date.now();
  await client.connect(transport);
  const pending = client
    .callTool({ name: 'thread_run', arguments: {} }, undefined, {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
      resetTimeoutOnProgress: true,
      onprogress: () => {},
    })
    .then(result => ({
      ok: true, timeoutMs, startedAtEpochMs, elapsedMs: Date.now() - startedAtEpochMs,
      text: result.content?.[0]?.text ?? null,
    }))
    .catch(error => ({
      ok: false, timeoutMs, startedAtEpochMs, elapsedMs: Date.now() - startedAtEpochMs,
      error: String(error?.message ?? error),
    }))
    .then((outcome) => {
      fs.writeFileSync(resultFile, JSON.stringify(outcome));
      return outcome;
    })
    .finally(() => transport.close().catch(() => {}));
  return { pending };
}

function emit(payload) {
  return new Promise(resolve => process.stdout.write(`${JSON.stringify(payload)}\n`, resolve));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', async (line) => {
  const request = JSON.parse(line);
  const { pending } = await issueToolCall();
  if (detach) await delay(DETACH_SETTLE_MS);
  else await pending;
  await emit({
    type: 'assistant',
    message: { id: 'a1', model: 'claude-reported-trial', content: [{ type: 'text', text: 'held' }] },
  });
  await emit({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id, result: 'held', num_turns: 1,
  });
  lines.close();
  // Leave the way a real CLI does — promptly, and without waiting on a transport whose peer may
  // already be gone. In detach mode that also leaves the sidecar holding, so only the containment
  // boundary can account for it.
  process.exit(0);
});
