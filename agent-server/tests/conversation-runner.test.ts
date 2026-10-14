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
import { composeUserPrompt, userProfileBlock } from '../src/domain/runs/prompt.js';
import {
  conversationRunPolicy,
  resolveConversationAgent,
  resolveConversationBoard,
  resolveConversationProject,
} from '../src/orchestration/conversation-request.js';
import { DIRECT_RUN_POLICY } from '../src/domain/runs/builders.js';
// The hold gate moved with the hold decision itself: `conversation-runner.ts` is gone and the Turn
// owns "can this run produce a background continuation" (orchestration/turn/turn.ts).
import { supportsBackgroundContinuation } from '../src/orchestration/turn/turn.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/capabilities.js';
import type { BoardPromptContext } from '../src/domain/boards/board-context.js';
import type { ResolvedEnvironment } from '../src/core/types/environment-types.js';
import type { Project } from '../src/domain/projects/project-types.js';

function makeAgentConfig(overrides: Partial<ResolvedEnvironment> = {}): ResolvedEnvironment {
  return {
    profile: '__active__',
    directive: '',
    systemPrompt: 'SYSTEM',
    promptTemplate: '{{input}}',
    claudeAgent: null,
    outputStyle: null,
    tools: 'Read',
    pluginDirs: null,
    ...overrides,
  } as ResolvedEnvironment;
}

/** A copy of the composition a conversation turn performs (orchestration/conversation-request.ts):
 *  a thread-free turn is the agent's template plus the first-turn ambient blocks, nothing else. */
function conversationPrompt(
  agentConfig: ResolvedEnvironment,
  input: string,
  opts: {
    includeUserContext?: boolean;
    project?: { id: string; contextDir: string } | null;
    board?: BoardPromptContext | null;
  } = {},
): string {
  const { includeUserContext = true, project = null, board = null } = opts;
  return composeUserPrompt(
    { directive: agentConfig.directive, promptTemplate: agentConfig.promptTemplate },
    input,
    { userContext: userProfileBlock(includeUserContext), project, board },
  );
}

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
});

// ── The agent template owns the execution environment ───────────────────────

function policyFor(overrides: Partial<ResolvedEnvironment>) {
  return conversationRunPolicy(makeAgentConfig(overrides), { channel: 'web:abc123' });
}

test('an agent that declares no environment reproduces the shared direct-run policy', () => {
  const policy = policyFor({});
  assert.equal(policy.hooks, DIRECT_RUN_POLICY.hooks);
  assert.equal(policy.loadRules, DIRECT_RUN_POLICY.loadRules);
  assert.equal(policy.mcpComposition, DIRECT_RUN_POLICY.mcpComposition);
  assert.equal(policy.captureTranscripts, DIRECT_RUN_POLICY.captureTranscripts);
  // Absent means "whatever the backend loads on its own" and must not be defaulted to a value.
  assert.equal(policy.skills, undefined);
  assert.equal(policy.settingSources, undefined);
});

test('disableHooks, loadRules and mcpComposition on the agent reach the conversation policy', () => {
  assert.equal(policyFor({ disableHooks: true }).hooks, false);
  assert.equal(policyFor({ disableHooks: false }).hooks, true);
  assert.equal(policyFor({ loadRules: false }).loadRules, false);
  // The conversation surface's default survives an agent that states nothing.
  assert.equal(policyFor({ mcpComposition: 'none' }).mcpComposition, 'none');
  assert.equal(policyFor({}).mcpComposition, 'direct');
});

test('skills and settingSources travel from the agent to the policy verbatim', () => {
  assert.equal(policyFor({ skills: false }).skills, false);
  assert.deepEqual(policyFor({ settingSources: [] }).settingSources, []);
  assert.deepEqual(policyFor({ settingSources: ['project'] }).settingSources, ['project']);
});

// ── which agent a turn opens as ─────────────────────────────────────────────

test('the agent chain is session, then channel, then global, then main', () => {
  const known = new Set(['main', 'nimbus', 'orchard']);
  const resolve = (name: string) => (known.has(name) ? makeAgentConfig() : null);
  const pick = (candidates: Array<string | null>) =>
    resolveConversationAgent(candidates, resolve).agentName;

  // The session's own choice beats everything below it.
  assert.equal(pick(['nimbus', 'orchard']), 'nimbus');
  // No session choice → the channel's (which getDefaultAgent already folded with the global).
  assert.equal(pick([null, 'orchard']), 'orchard');
  // Nothing anywhere → the floor.
  assert.equal(pick([null, null]), 'main');
});

test('an agent that no longer exists falls through instead of killing the turn', () => {
  // A session recorded `retired` and the template was deleted since. The channel's choice answers.
  const resolve = (name: string) => (name === 'orchard' ? makeAgentConfig() : null);
  assert.equal(resolveConversationAgent(['retired', 'orchard'], resolve).agentName, 'orchard');
});

test('a host where even main is unresolvable fails loudly', () => {
  assert.throws(
    () => resolveConversationAgent(['nimbus'], () => null),
    /Unknown default agent: main/,
  );
});

test('an agent with projectContext:false gets no [Session Project] block', () => {
  const args = {
    channel: 'web:abc123',
    projectId: 'proj-a',
    isFreshSession: true,
    store: makeStore([userProject]),
  };
  assert.deepEqual(resolveConversationProject(args), { id: 'proj-a', contextDir: '/ctx/projects/proj-a' });
  assert.equal(resolveConversationProject({ ...args, projectContext: false }), null);
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

// ── [Board] block ───────────────────────────────────────────────────────────

const boardCtx: BoardPromptContext = {
  id: 'b-1',
  title: 'Ship the parser',
  dir: '/ctx/projects/proj-a/boards/ship-the-parser',
};

test('the board block names the board and its path and stays short', () => {
  const prompt = conversationPrompt(makeAgentConfig({ directive: '' }), 'hi', { board: boardCtx, includeUserContext: false });
  assert.ok(prompt.startsWith('[Board]'));
  assert.ok(prompt.includes('"Ship the parser" (b-1)'));
  assert.ok(prompt.includes('/ctx/projects/proj-a/boards/ship-the-parser'));
  assert.ok(prompt.includes('re-read it right before every edit'));
  assert.ok(prompt.length < 1_000, `block unexpectedly large: ${prompt.length}`);
});

/** A session record carrying only the board fields the resolver reads. */
function session(fields: Record<string, unknown>): Parameters<typeof resolveConversationBoard>[0] {
  return { sessionId: 'sess-1', boardId: null, boardBlockFor: null, ...fields } as never;
}

const loadBoard = (async (id: string) => ({ ...boardCtx, id })) as typeof import('../src/domain/boards/board-context.js').loadBoardPromptContext;

test('resolveConversationBoard loads the context only for bound sessions, best-effort', async () => {
  const markDelivered = async () => undefined;
  const fresh = { isFreshSession: true };
  const bound = await resolveConversationBoard(session({ boardId: 'b-9' }), fresh, { load: loadBoard, markDelivered });
  assert.equal(bound?.id, 'b-9');
  assert.equal(await resolveConversationBoard(session({ boardId: null }), fresh, { load: loadBoard, markDelivered }), null);
  const failing = await resolveConversationBoard(session({ boardId: 'b-9' }), fresh, {
    load: (async () => { throw new Error('unreadable'); }) as typeof loadBoard, markDelivered,
  });
  assert.equal(failing, null, 'injection is best-effort — failures inject nothing');
});

test('resolveConversationBoard delivers once per binding, and again after the marker is cleared', async () => {
  const marked: Array<[string, string]> = [];
  const deps = { load: loadBoard, markDelivered: async (id: string, key: string) => { marked.push([id, key]); } };
  const resumed = { isFreshSession: false };

  // Bound mid-conversation (a lead opened a board): delivered on the next turn.
  assert.equal((await resolveConversationBoard(session({ boardId: 'b-1' }), resumed, deps))?.id, 'b-1');
  assert.deepEqual(marked.at(-1), ['sess-1', 'b-1']);
  // Same binding later: already in backend history.
  assert.equal(await resolveConversationBoard(session({ boardId: 'b-1', boardBlockFor: 'b-1' }), resumed, deps), null);
  // Compaction cleared the marker: delivered again.
  assert.equal((await resolveConversationBoard(session({ boardId: 'b-1', boardBlockFor: null }), resumed, deps))?.id, 'b-1');
  // Rebound to another board: the new one is delivered.
  assert.equal((await resolveConversationBoard(session({ boardId: 'b-2', boardBlockFor: 'b-1' }), resumed, deps))?.id, 'b-2');
  // A legacy commission marker never matches a board id.
  assert.equal((await resolveConversationBoard(session({ boardId: 'b-1', boardBlockFor: 'active:b-1' }), resumed, deps))?.id, 'b-1');
  // A fresh spawn re-delivers even against a matching marker.
  assert.equal((await resolveConversationBoard(session({ boardId: 'b-1', boardBlockFor: 'b-1' }), { isFreshSession: true }, deps))?.id, 'b-1');
});

test('resolveConversationBoard does not record a delivery for a closed or missing board', async () => {
  const marked: string[] = [];
  const nothing = await resolveConversationBoard(session({ boardId: 'b-9' }), { isFreshSession: true }, {
    load: (async () => null) as typeof loadBoard,
    markDelivered: async (_id: string, key: string) => { marked.push(key); },
  });
  assert.equal(nothing, null);
  assert.deepEqual(marked, []);
});
