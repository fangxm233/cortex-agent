// input:  hook scripts written into the test HOOKS_DIR + handlePostToolUse
// output: In-process hook execution and spawned-form fallback regressions
// pos:    Verifies the PI hook bridge's in-process entry point
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { HOOKS_DIR } from '../src/core/paths.js';
import { handlePostToolUse, resetInprocHooks } from '../src/agent-adapter/pi/hook-bridge.js';
import type { HookContext, ToolResultEvent } from '../src/agent-adapter/pi/hook-bridge.js';
import type { HookEntry } from '../src/store/hook-registry.js';

function ctx(): HookContext {
  return { cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } };
}

function toolResult(): ToolResultEvent {
  return {
    toolName: 'read',
    toolCallId: 'call-1',
    input: { file_path: '/tmp/x' },
    content: [{ type: 'text', text: 'tool output' }],
    isError: false,
  };
}

function writeHook(name: string, source: string): HookEntry {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOOKS_DIR, name), source, 'utf8');
  resetInprocHooks();
  return { id: name, event: 'agent:post-tool', run: { script: name } };
}

function markerPath(name: string): string {
  return path.join(HOOKS_DIR, `${name}.marker.json`);
}

test('a hook exporting runHook runs in this process with the session env', async () => {
  const marker = markerPath('inproc');
  const entry = writeHook('inproc-probe.mjs', `
import { writeFileSync } from 'node:fs';
export function runHook(payload, env) {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
    pid: process.pid,
    session: env.CORTEX_SESSION_ID,
    tool: payload.tool_name,
  }));
  return { hookSpecificOutput: { additionalContext: 'from-inproc' } };
}
`);

  const event = toolResult();
  const result = await handlePostToolUse(event, ctx(), [entry], {
    CORTEX_SESSION_ID: 'sess-inproc',
  } as NodeJS.ProcessEnv);

  const observed = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
  assert.equal(observed.pid, process.pid, 'hook ran in the daemon process, not a child');
  assert.equal(observed.session, 'sess-inproc', 'hook saw the session environment');
  assert.equal(observed.tool, 'Read', 'hook saw the Claude-shaped payload');
  assert.ok(result, 'content was modified');
  assert.equal(
    JSON.stringify(event.content).includes('from-inproc'), true,
    'additionalContext was appended to the tool result',
  );
});

test('a hook without runHook keeps the spawned form', async () => {
  const marker = markerPath('spawned');
  const entry = writeHook('spawned-probe.mjs', `
import { readFileSync, writeFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, tool: payload.tool_name }));
process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'from-child' } }));
`);

  const event = toolResult();
  await handlePostToolUse(event, ctx(), [entry], {} as NodeJS.ProcessEnv);

  const observed = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
  assert.notEqual(observed.pid, process.pid, 'hook ran in a child process');
  assert.equal(
    JSON.stringify(event.content).includes('from-child'), true,
    'the spawned hook still contributes its context',
  );
});

test('the deployed cortex-md-injector exposes the in-process entry point', async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../defaults/hooks/cortex-md-injector.mjs'), 'utf8',
  );
  assert.ok(source.includes('export function runHook('), 'injector exports runHook');
});
