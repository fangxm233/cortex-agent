// input:  a fixture root, a backend, a queue file and an observations directory
// output: an executable fake Claude or PI CLI that answers, hangs on, or prices one queued step
// pos:    Shared fake backend CLI for the in-trial benchmark thread suites
// >>> If I am updated, update my header and folder CORTEX.md <<<

import type { Backend } from '../../../src/agent-adapter/types.js';
import { writeFixtureAsset } from '../benchmark/trial-thread-policy-fixture.js';

/** What `--version` answers. A caller that folds a CLI version into an identity hash must use this
 *  constant rather than restate the string. */
export const FAKE_BACKEND_CLI_VERSION = 'fake-backend-cli 1.0.0';

/** The two observation files the script appends to, beside its per-step records. Both are named
 *  here so a reader does not have to parse the generated script to find them. */
export const FAKE_BACKEND_PROMPTS_FILE = 'prompts.ndjson';
export const FAKE_BACKEND_LIFECYCLE_FILE = 'lifecycle.ndjson';

/** One queued step per invocation. Every assistant message the fake emits is named by the test
 *  that queued it — the fake hard-codes no text of its own, and a step whose `text` is null emits
 *  no assistant message at all, which is the case the shipped fakes cannot reach. */
export interface FakeStepScript {
  /** The step's terminal assistant message; null → the step emits none. */
  text: string | null;
  /** An earlier, separate assistant message the same step emits before its terminal one. */
  lead?: string;
  /** Files the step's own process writes, relative to the cwd the lease armed for it. This is
   *  how a step mutates a workspace: through the real child, in the real placement. */
  writes?: Record<string, string>;
  /** The step reads its prompt, records that it started, and then answers nothing — it stays
   *  resident until something kills it. This is the vehicle's cancellation case. */
  hang?: boolean;
  /** The step's reported cost, emitted in its own backend's accounting shape. Absent → the step
   *  reports no cost at all, which is not the same as reporting zero. */
  costUsd?: number;
  /** Text the step appends to the thread artifact its own prompt names. A role that runs in a
   *  disposable snapshot has its output appended for it at the step boundary; a role in the shared
   *  workspace has to write the artifact itself, and this is the fake's way of doing that. */
  appendsToArtifact?: string;
}

/** Takes the next unclaimed step from the queue, records what the process actually saw, then
 *  answers one turn in that backend's own wire shape. Every path the script writes is baked into
 *  it at generation time: a trial pins its child's environment to a fixed set, so an observation
 *  channel that travelled through the environment would be deleted before the child read it. */
export function writeFakeBackendCli(
  root: string, label: string, backend: Backend, queue: string, observations: string,
): string {
  const take = `
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`${FAKE_BACKEND_CLI_VERSION}\n`)});
  process.exit(0);
}
const queue = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, 'utf8'));
const index = queue.findIndex(entry => entry.taken !== true);
const step = queue[index];
step.taken = true;
fs.writeFileSync(${JSON.stringify(queue)}, JSON.stringify(queue));
fs.mkdirSync(${JSON.stringify(observations)}, { recursive: true });
fs.writeFileSync(path.join(${JSON.stringify(observations)}, \`step-\${index}.json\`), JSON.stringify({
  argv, cwd: process.cwd(), env: process.env, pid: process.pid,
}));
function note(file, value) {
  fs.appendFileSync(path.join(${JSON.stringify(observations)}, file), JSON.stringify(value) + '\\n');
}
process.on('SIGTERM', () => {
  note(${JSON.stringify(FAKE_BACKEND_LIFECYCLE_FILE)}, { event: 'stopped', pid: process.pid });
  process.exit(0);
});
/** Recorded when the prompt arrives, not when the process starts: an observer waiting on this has
 *  then seen a child that the adapter really drove, not merely one that was spawned. */
function observePrompt(message) {
  note(${JSON.stringify(FAKE_BACKEND_PROMPTS_FILE)}, message);
  note(${JSON.stringify(FAKE_BACKEND_LIFECYCLE_FILE)}, { event: 'started', pid: process.pid });
  if (typeof step.appendsToArtifact !== 'string') return;
  const artifact = String(message).match(/(\\/[^\\s]+\\/artifact\\.md)/)?.[1];
  if (artifact) fs.appendFileSync(artifact, step.appendsToArtifact);
}
for (const [name, content] of Object.entries(step.writes ?? {})) {
  const target = path.resolve(process.cwd(), name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function say(record) { process.stdout.write(\`\${JSON.stringify(record)}\\n\`); }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
`;
  const body = backend === 'claude'
    ? `
lines.once('line', (line) => {
  const request = JSON.parse(line);
  observePrompt(request.message.content);
  if (step.hang === true) return void setInterval(() => {}, 1000);
  if (step.lead) {
    say({ type: 'assistant', message: { id: 'a0', model: 'fixture-reported', content: [{ type: 'text', text: step.lead }] } });
  }
  if (step.text !== null) {
    say({ type: 'assistant', message: { id: 'a1', model: 'fixture-reported', content: [{ type: 'text', text: step.text }] } });
  }
  say({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id ?? 'claude-trial-session',
    result: step.text ?? '', num_turns: 1,
    ...(step.costUsd === undefined ? {} : { total_cost_usd: step.costUsd }),
  });
  setTimeout(() => process.exit(0), 10);
});
`
    : `
lines.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.type === 'get_state') {
    say({ type: 'response', id: command.id, command: 'get_state', success: true, data: { sessionId: 'pi-trial-session' } });
    return;
  }
  if (command.type === 'get_session_stats') {
    say({ type: 'response', id: command.id, command: 'get_session_stats', success: true, data: { contextUsage: { contextWindow: 200000, tokens: 1024, percent: 0.5 } } });
    return;
  }
  if (command.type === 'prompt') {
    observePrompt(command.message);
    if (step.hang === true) return;
    // Distinct message ids, so the adapter's delta buffer flushes each one as its own
    // assistant_text rather than concatenating both into a single message.
    if (step.lead) {
      say({ type: 'message_update', message: { id: 'msg-0' }, assistantMessageEvent: { type: 'text_delta', delta: step.lead } });
    }
    if (step.text !== null) {
      say({ type: 'message_update', message: { id: 'msg-1' }, assistantMessageEvent: { type: 'text_delta', delta: step.text } });
    }
    say({ type: 'agent_end', messages: [{ role: 'assistant', provider: 'anthropic', model: 'fixture-reported', usage: { input: 12, output: 4, cost: { total: step.costUsd ?? 0 } } }] });
    say({ type: 'agent_settled' });
  }
});
lines.on('close', () => process.exit(0));
`;
  const script = writeFixtureAsset(root, `${label}/cli.mjs`, take + body);
  return writeFixtureAsset(
    root, `${label}/cli`,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    0o755,
  );
}
