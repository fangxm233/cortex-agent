// input:  runner prompt/options and pinned CORTEX_HOME
// output: deterministic zero-cost agent handle and invocation marker
// pos:    No-model agent facade for the current-runner baseline
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';

export function runAgent(prompt, options) {
  const marker = path.join(process.env.CORTEX_HOME, 'data/fake-run-agent.jsonl');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.appendFileSync(marker, `${JSON.stringify({ prompt, profileName: options.profileName })}\n`);
  options.onAssistantMessage?.('fake step complete');
  return {
    sessionId: 'fake-backend-session',
    agentProcess: null,
    kill: () => {},
    promise: Promise.resolve({
      finalOutput: 'fake step complete',
      sessionId: 'fake-backend-session',
      total_cost_usd: 0,
      num_turns: 1,
      rateLimited: false,
    }),
  };
}

export function getClaudeMode() { return 'print'; }
export function getActiveBackend() { return 'claude'; }
export function getActiveProfile() { return 'baseline'; }
export function resolveRateLimitProvider() { return 'anthropic'; }
export function closeSessionsByPrefix() {}
