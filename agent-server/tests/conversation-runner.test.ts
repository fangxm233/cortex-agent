//
// Plain user messages no longer run as a `templateName:'default'` thread; they run through a Turn,
// whose request is assembled by `prepareConversationRequest` with composeUserPrompt (no thread, no
// artifact, no [ABORT] protocol). These tests pin that assembly so the migration does not
// silently change every chat turn. (The module they used to import from, `conversation-runner.ts`,
// was split into `conversation-request.ts` + `turn/turn.ts`; the assertions are unchanged.)

test('the interactive hold gate reads the continuation capability, not the backend name', () => {
  // PI opens no turn of its own after a foreground result, so there is nothing for a hold to hold.
  assert.ok(CAPABILITIES_BY_BACKEND.claude.has(Capability.BackgroundContinuation));
  assert.equal(CAPABILITIES_BY_BACKEND.pi.has(Capability.BackgroundContinuation), false);

  const runOf = (backend: 'claude' | 'pi') =>
    ({ capabilities: CAPABILITIES_BY_BACKEND[backend] } as never);
  assert.equal(supportsBackgroundContinuation(runOf('claude')), true);
  assert.equal(supportsBackgroundContinuation(runOf('pi')), false);
});



import { test } from 'vitest';
import assert from 'node:assert/strict';
import { THREAD_PROTOCOL_PREAMBLE } from '../src/domain/threads/prompt-builder.js';
import { composeUserPrompt, userProfileBlock } from '../src/domain/runs/prompt.js';
import {
  resolveConversationCommission,
  resolveConversationProject,
} from '../src/orchestration/conversation-request.js';
// The hold gate moved with the hold decision itself: `conversation-runner.ts` is gone and the Turn
// owns "can this run produce a background continuation" (orchestration/turn/turn.ts).
import { supportsBackgroundContinuation } from '../src/orchestration/turn/turn.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/capabilities.js';
import type { ActiveCommissionContext, CommissionPromptContext } from '../src/domain/commissions/commission-context.js';
import type { AgentSlotConfig } from '../src/core/types/thread-types.js';
import type { Project } from '../src/domain/projects/project-types.js';

function makeAgentConfig(overrides: Partial<AgentSlotConfig> = {}): AgentSlotConfig {
  return {
    slotId: 'main',
    profile: '__active__',
    persistSession: false,
    directive: '',
    systemPrompt: 'SYSTEM',
    promptTemplate: '{{input}}',
    claudeAgent: null,
    outputStyle: null,
    tools: 'Read',
    pluginDirs: null,
    stages: undefined,
    entryStage: undefined,
    ...overrides,
  } as AgentSlotConfig;
}

/** The exact composition a conversation turn performs (orchestration/conversation-request.ts): a
 *  thread-free turn is the agent's template plus the first-turn ambient blocks, nothing else.
 *  Kept here so these tests keep pinning that one call site after P3.3b moved the composition
 *  into domain/runs/prompt.ts. */
function conversationPrompt(
  agentConfig: AgentSlotConfig,
  input: string,
  opts: {
    includeUserContext?: boolean;
    project?: { id: string; contextDir: string } | null;
    commission?: CommissionPromptContext | null;
  } = {},
): string {
  const { includeUserContext = true, project = null, commission = null } = opts;
  return composeUserPrompt(
    { directive: agentConfig.directive, promptTemplate: agentConfig.promptTemplate },
    input,
    { userContext: userProfileBlock(includeUserContext), project, commission },
  );
}

test('conversation prompt with the default {{input}} template and empty directive is just the message', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hello world');
  assert.equal(prompt, 'hello world');
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE), 'conversation prompt must not contain the thread protocol preamble');
});

test('conversation prompt prepends a non-empty directive, still no preamble', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: 'You are the direct agent.' }), 'what is 2+2?');
  assert.ok(prompt.startsWith('You are the direct agent.'));
  assert.ok(prompt.includes('what is 2+2?'));
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE));
});

test('conversation prompt applies a custom promptTemplate', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '', promptTemplate: 'User asked: {{input}}' }), 'status?');
  assert.equal(prompt, 'User asked: status?');
});

// ── Project prefix (Web UI direct sessions bound to a project) ──────────────

test('conversation prompt injects a project block naming the project id and context dir', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: 'DIRECTIVE' }), 'hello', {
    project: { id: 'tactile-vr', contextDir: '/ctx/projects/tactile-vr' },
  });
  assert.ok(prompt.includes('tactile-vr'), 'project id must appear in the prompt');
  assert.ok(prompt.includes('/ctx/projects/tactile-vr'), 'project context dir must appear in the prompt');
  // The project block is a prefix: it comes before the user message.
  assert.ok(prompt.indexOf('tactile-vr') < prompt.indexOf('hello'));
  assert.ok(prompt.endsWith('hello'), 'user message stays last');
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE));
});

test('conversation prompt without a project opt injects no project block', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hello');
  assert.equal(prompt, 'hello');
});

test('conversation prompt with project:null behaves like no project', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hello', { project: null });
  assert.equal(prompt, 'hello');
});

// ── resolveConversationProject gating ───────────────────────────────────────

function makeStore(projects: Project[]): { get(id: string): Project | undefined } {
  return { get: (id: string) => projects.find((p) => p.id === id) };
}

const userProject: Project = { id: 'proj-a', name: 'proj-a', kind: 'user', contextDir: '/ctx/projects/proj-a' };
const generalProject: Project = { id: 'general', name: 'general', kind: 'general', contextDir: '/ctx/projects/general' };

test('resolveConversationProject returns the project for a fresh web session bound to a user project', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'proj-a', isFreshSession: true, store: makeStore([userProject, generalProject]),
  });
  assert.deepEqual(p, { id: 'proj-a', contextDir: '/ctx/projects/proj-a' });
});

test('resolveConversationProject returns null for non-web channels', () => {
  const p = resolveConversationProject({
    channel: 'slack:C0123', projectId: 'proj-a', isFreshSession: true, store: makeStore([userProject]),
  });
  assert.equal(p, null);
});

test('resolveConversationProject returns null on a resumed (non-fresh) session', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'proj-a', isFreshSession: false, store: makeStore([userProject]),
  });
  assert.equal(p, null);
});

test('resolveConversationProject returns null for the general umbrella project', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'general', isFreshSession: true, store: makeStore([userProject, generalProject]),
  });
  assert.equal(p, null);
});

test('resolveConversationProject returns null when the project is unknown to the store', () => {
  const p = resolveConversationProject({
    channel: 'web:abc123', projectId: 'deleted-proj', isFreshSession: true, store: makeStore([userProject]),
  });
  assert.equal(p, null);
});

// ── [Commission] block ──────────────────────────────────────────────────────

const commissionCtx: ActiveCommissionContext = {
  phase: 'active',
  id: 'comm-1',
  title: 'Ship the parser',
  dir: '/ctx/projects/proj-a/commissions/ship-the-parser',
  hasLedger: true,
};

test('conversation prompt injects the commission block as an index plus the protocol', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hello', {
    project: { id: 'proj-a', contextDir: '/ctx/projects/proj-a' },
    commission: commissionCtx,
  });
  assert.match(prompt, /\[Commission\] This session belongs to the commission "Ship the parser" \(comm-1\)/);
  assert.match(prompt, /Commission directory: \/ctx\/projects\/proj-a\/commissions\/ship-the-parser/);
  assert.match(prompt, /Read both files now/);
  assert.match(prompt, /Commission protocol:/);
  assert.ok(prompt.indexOf('[Session Project]') < prompt.indexOf('[Commission]'), 'commission block follows the project block');
  assert.ok(prompt.endsWith('hello'));
});

test('the commission block never pastes contract or ledger content', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hi', {
    commission: commissionCtx,
  });
  assert.ok(!prompt.includes('--- contract.md ---'), 'no contract snapshot');
  assert.ok(!prompt.includes('ledger digest'), 'no ledger snapshot');
  // The whole block stays small enough to be free at the start of every commission session.
  assert.ok(prompt.length < 1_800, `block unexpectedly large: ${prompt.length}`);
});

test('conversation prompt tells the agent to create ledger.md when it does not exist yet', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hi', {
    commission: { ...commissionCtx, hasLedger: false },
  });
  assert.match(prompt, /ledger\.md   — NOT created yet/);
});

test('a session still drafting its contract is told so, and pointed at cortex_commission_start', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'go', {
    commission: { phase: 'draft', dir: '/ctx/projects/proj-a/commissions/_draft-cortex-4c80d3' },
  });
  assert.match(prompt, /\[Commission\] This session is drafting a commission contract/);
  assert.match(prompt, /_draft-cortex-4c80d3/);
  assert.match(prompt, /call cortex_commission_start now/);
  // The block serves both entries: the agent's own call and the user switching the mode on mid
  // conversation. The latter must not produce another round of "shall we?".
  assert.match(prompt, /If the user turned this mode on for you/);
  // No contract exists yet, so the maintenance protocol would be noise.
  assert.ok(!prompt.includes('Commission protocol:'), 'no execution protocol before a contract');
});

test('resolveConversationCommission loads the context only for commission sessions', async () => {
  const load = (async (id: string) => ({ ...commissionCtx, id })) as typeof import('../src/domain/commissions/commission-context.js').loadCommissionPromptContext;
  const enabled = () => true;
  const markDelivered = async () => undefined;
  const bound = await resolveConversationCommission('sess-1', { isFreshSession: true }, {
    getSession: async () => ({ commissionId: 'comm-9' }), load, enabled, markDelivered,
  });
  assert.equal(bound?.phase === 'active' ? bound.id : null, 'comm-9');

  const unbound = await resolveConversationCommission('sess-1', { isFreshSession: true }, {
    getSession: async () => ({ commissionId: null }), load, enabled, markDelivered,
  });
  assert.equal(unbound, null);

  // The drafting window: no commission id exists yet, so the draft directory is what gets injected.
  const drafting = await resolveConversationCommission('sess-1', { isFreshSession: true }, {
    getSession: async () => ({ commissionId: null, commissionDraft: '_draft-cortex-4c80d3', projectId: 'proj-a' }),
    load, enabled, markDelivered,
    loadDraft: (projectId, draft) => ({ phase: 'draft', dir: `/ctx/${projectId}/commissions/${draft}` }),
  });
  assert.deepEqual(drafting, { phase: 'draft', dir: '/ctx/proj-a/commissions/_draft-cortex-4c80d3' });

  const failing = await resolveConversationCommission('sess-1', { isFreshSession: true }, {
    getSession: async () => { throw new Error('registry down'); }, load, enabled, markDelivered,
  });
  assert.equal(failing, null, 'injection is best-effort — failures inject nothing');
});

// --- DR-0037 v4: delivery follows the binding, not the session's age ----------------------------

test('resolveConversationCommission delivers once per binding and records which one', async () => {
  const load = (async (id: string) => ({ ...commissionCtx, id })) as typeof import('../src/domain/commissions/commission-context.js').loadCommissionPromptContext;
  const enabled = () => true;
  const marked: Array<[string, string]> = [];
  const markDelivered = async (id: string, key: string) => { marked.push([id, key]); };
  const deps = (session: Record<string, unknown>) => ({
    getSession: async () => session, load, enabled, markDelivered,
    loadDraft: (projectId: string, draft: string) => ({ phase: 'draft' as const, dir: `/ctx/${projectId}/${draft}` }),
  });

  // Entered mid-conversation (agent called cortex_commission_start, or the user switched it on):
  // not a fresh session, nothing delivered yet — v3 injected nothing here, forever.
  const entered = await resolveConversationCommission('sess-1', { isFreshSession: false },
    deps({ commissionDraft: '_draft-cortex-a1', projectId: 'proj-a', commissionBlockFor: null }));
  assert.equal(entered?.phase, 'draft');
  assert.deepEqual(marked.at(-1), ['sess-1', 'draft:_draft-cortex-a1']);

  // Same binding on a later turn: already in backend history, so nothing is re-sent.
  const repeat = await resolveConversationCommission('sess-1', { isFreshSession: false },
    deps({ commissionDraft: '_draft-cortex-a1', projectId: 'proj-a', commissionBlockFor: 'draft:_draft-cortex-a1' }));
  assert.equal(repeat, null);

  // The contract lands mid-conversation: the key changes, so the active block follows.
  const boundNow = await resolveConversationCommission('sess-1', { isFreshSession: false },
    deps({ commissionId: 'comm-9', commissionBlockFor: 'draft:_draft-cortex-a1' }));
  assert.equal(boundNow?.phase, 'active');
  assert.deepEqual(marked.at(-1), ['sess-1', 'active:comm-9']);

  // A fresh spawn re-delivers even against a matching marker: a process that died before writing
  // history left the marker pointing at a conversation that never contained the block.
  const refreshed = await resolveConversationCommission('sess-1', { isFreshSession: true },
    deps({ commissionId: 'comm-9', commissionBlockFor: 'active:comm-9' }));
  assert.equal(refreshed?.phase, 'active');
});

test('resolveConversationCommission does not record a delivery it could not load', async () => {
  const marked: string[] = [];
  const nothing = await resolveConversationCommission('sess-1', { isFreshSession: true }, {
    getSession: async () => ({ commissionId: 'comm-9' }),
    load: (async () => null) as typeof import('../src/domain/commissions/commission-context.js').loadCommissionPromptContext,
    enabled: () => true,
    markDelivered: async (_id: string, key: string) => { marked.push(key); },
  });
  assert.equal(nothing, null);
  assert.deepEqual(marked, [], 'an empty contract must not burn the delivery marker');
});

test('resolveConversationCommission injects nothing while the feature switch is off', async () => {
  const load = (async (id: string) => ({ ...commissionCtx, id })) as typeof import('../src/domain/commissions/commission-context.js').loadCommissionPromptContext;
  // A session bound while the mode was on must stop receiving its contract block the moment the
  // switch goes off.
  const off = await resolveConversationCommission('sess-1', { isFreshSession: true }, {
    getSession: async () => ({ commissionId: 'comm-9' }), load, enabled: () => false,
  });
  assert.equal(off, null);
});
