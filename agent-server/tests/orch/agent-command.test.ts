import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

// `!agent` parsing: which of the four forms reaches which rule. Every bare form is CHANNEL-scoped
// (that is the whole point of the per-session selection); the daemon-wide default is reachable only
// behind the explicit `global` prefix. The rules themselves are tested in
// tests/domain/agents/agent-switch.test.ts — here we only pin the dispatch.

const AGENTS: Record<string, { name: string; profile: string; claudeAgent?: string }> = {
  main: { name: 'main', profile: '__active__' },
  nimbus: { name: 'nimbus', profile: 'execute' },
};

let calls: string[] = [];
let switchResult: unknown = { ok: true, agentName: 'nimbus', effectiveProfile: 'execute', backendChanged: false };
let channelAgents: Record<string, string> = {};
let globalAgent: string | null = null;

vi.mock('@domain/agents/index.js', () => ({
  getChannelAgents: () => channelAgents,
  getDefaultAgent: () => globalAgent,
  setDefaultAgent: (name: string | null, channel?: string) => {
    calls.push(`setDefaultAgent(${name}${channel ? `,${channel}` : ''})`);
  },
  switchChannelAgent: async ({ channel, name }: { channel: string; name: string }) => {
    calls.push(`switchChannelAgent(${channel},${name})`);
    return switchResult;
  },
  clearChannelAgentSelection: async (channel: string) => { calls.push(`clear(${channel})`); },
  // Unused by `!agent`, but mode.ts imports them at module level.
  setChannelModelOverride: () => {},
  setChannelThinkingOverride: () => {},
  getActiveProfile: () => 'execute',
  setActiveProfile: () => {},
  clearChannelProfile: () => {},
  switchChannelProfile: async () => ({ ok: true }),
}));

vi.mock('@domain/threads/index.js', () => ({
  getAgent: (name: string) => AGENTS[name] ?? null,
  listAgents: () => Object.values(AGENTS),
}));

const { createAgentHandler } = await import('../../src/orchestration/routing/commands/mode.js');
const { MockAdapter } = await import('../../src/platform/testing.js');

/** Run `!agent …` on a channel and return what it posted. */
async function run(message: string): Promise<string> {
  const adapter = new MockAdapter();
  const posted: string[] = [];
  adapter.postMessage = (async (_dest: unknown, content: { text: string }) => {
    posted.push(content.text);
    return { messageId: 'm1' };
  }) as never;
  const result = await createAgentHandler()('slack:C1', adapter as never, message) as
    { text?: string } | undefined;
  // The no-argument form with a router returns rich blocks instead of posting.
  return posted.join('\n') || result?.text || '';
}

beforeEach(() => {
  calls = [];
  channelAgents = {};
  globalAgent = null;
  switchResult = { ok: true, agentName: 'nimbus', effectiveProfile: 'execute', backendChanged: false };
});

test('`!agent <name>` goes through the per-channel switch rule', async () => {
  const text = await run('!agent nimbus');
  assert.deepEqual(calls, ['switchChannelAgent(slack:C1,nimbus)']);
  assert.match(text, /nimbus/);
});

test('`!agent reset` (and its aliases) clears the channel, never the global default', async () => {
  for (const word of ['reset', 'clear', 'off', 'none', 'disable']) {
    calls = [];
    await run(`!agent ${word}`);
    assert.deepEqual(calls, ['clear(slack:C1)'], `!agent ${word}`);
  }
});

test('`!agent global <name>` is the only form that moves the daemon-wide default', async () => {
  await run('!agent global nimbus');
  assert.deepEqual(calls, ['setDefaultAgent(nimbus)']);
});

test('`!agent global off` clears the daemon-wide default', async () => {
  await run('!agent global off');
  assert.deepEqual(calls, ['setDefaultAgent(null)']);
});

test('`!agent global` with no name explains itself instead of guessing', async () => {
  const text = await run('!agent global');
  assert.deepEqual(calls, []);
  assert.match(text, /!agent global/);
});

test('an unknown name is reported with the list, and changes nothing', async () => {
  switchResult = { ok: false, reason: 'unknown-agent' };
  const text = await run('!agent ghost');
  assert.match(text, /ghost/);
  assert.match(text, /nimbus/, 'the available agents are named');
});

test('a cross-backend refusal explains the backend, not the agent', async () => {
  switchResult = { ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi' };
  const text = await run('!agent nimbus');
  assert.match(text, /claude/);
  assert.match(text, /pi/);
});

test('`!agent` names both layers: this conversation\'s agent and the global default', async () => {
  globalAgent = 'main';
  channelAgents = { 'slack:C1': 'nimbus' };
  const shown = await run('!agent');
  assert.match(shown, /nimbus/);
  assert.match(shown, /main/);
  assert.deepEqual(calls, [], 'reading changes nothing');
});

test('`!agent` on a channel with no selection of its own says it follows the global', async () => {
  globalAgent = 'main';
  const shown = await run('!agent');
  assert.match(shown, /main/);
});
