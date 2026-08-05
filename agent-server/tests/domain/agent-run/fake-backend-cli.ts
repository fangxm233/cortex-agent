// input:  a fixture root, a backend, a queue file and an observations directory
// output: an executable fake Claude or PI CLI that answers one queued step per invocation
// pos:    Shared fake backend CLI for the in-trial benchmark thread suites
// >>> If I am updated, update my header and folder CORTEX.md <<<

import type { Backend } from '../../../src/agent-adapter/types.js';
import { writeFixtureAsset } from '../benchmark/trial-thread-policy-fixture.js';

/** One queued step per invocation. Every assistant message the fake emits is named by the test
 *  that queued it — the fake hard-codes no text of its own, and a step whose `text` is null emits
 *  no assistant message at all, which is the case the shipped fakes cannot reach. */
export interface FakeStepScript {
  /** The step's terminal assistant message; null → the step emits none. */
  text: string | null;
  /** An earlier, separate assistant message the same step emits before its terminal one. */
  lead?: string;
}

/** Takes the next unclaimed step from the queue, records what the process actually saw, then
 *  answers one turn in that backend's own wire shape. */
export function writeFakeBackendCli(
  root: string, label: string, backend: Backend, queue: string, observations: string,
): string {
  const take = `
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const queue = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, 'utf8'));
const index = queue.findIndex(entry => entry.taken !== true);
const step = queue[index];
step.taken = true;
fs.writeFileSync(${JSON.stringify(queue)}, JSON.stringify(queue));
fs.mkdirSync(${JSON.stringify(observations)}, { recursive: true });
fs.writeFileSync(path.join(${JSON.stringify(observations)}, \`step-\${index}.json\`), JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,
}));
function say(record) { process.stdout.write(\`\${JSON.stringify(record)}\\n\`); }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
`;
  const body = backend === 'claude'
    ? `
lines.once('line', (line) => {
  const request = JSON.parse(line);
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
    // Distinct message ids, so the adapter's delta buffer flushes each one as its own
    // assistant_text rather than concatenating both into a single message.
    if (step.lead) {
      say({ type: 'message_update', message: { id: 'msg-0' }, assistantMessageEvent: { type: 'text_delta', delta: step.lead } });
    }
    if (step.text !== null) {
      say({ type: 'message_update', message: { id: 'msg-1' }, assistantMessageEvent: { type: 'text_delta', delta: step.text } });
    }
    say({ type: 'agent_end', messages: [{ role: 'assistant', provider: 'anthropic', model: 'fixture-reported', usage: { input: 12, output: 4, cost: { total: 0 } } }] });
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
