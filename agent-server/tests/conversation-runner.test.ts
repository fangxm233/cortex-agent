// input:  node:test, prompt-builder (buildConversationPrompt)
// output: prompt-assembly tests for the thread-free conversation path
// pos:    regression guard that runConversation's prompt is the directive + user message,
//         with no thread protocol preamble (plain user messages are not threads)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Plain user messages no longer run as a `templateName:'default'` thread; they run via
// runConversation, which assembles its prompt with buildConversationPrompt (no thread, no
// artifact, no [ABORT] protocol). These tests pin that assembly so the migration does not
// silently change every chat turn.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildConversationPrompt, THREAD_PROTOCOL_PREAMBLE } from '../src/domain/threads/prompt-builder.js';
import { resolveConversationProject } from '../src/orchestration/conversation-runner.js';
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

test('buildConversationPrompt with the default {{input}} template and empty directive is just the message', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello world');
  assert.equal(prompt, 'hello world');
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE), 'conversation prompt must not contain the thread protocol preamble');
});

test('buildConversationPrompt prepends a non-empty directive, still no preamble', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: 'You are the direct agent.' }), 'what is 2+2?');
  assert.ok(prompt.startsWith('You are the direct agent.'));
  assert.ok(prompt.includes('what is 2+2?'));
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE));
});

test('buildConversationPrompt applies a custom promptTemplate', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '', promptTemplate: 'User asked: {{input}}' }), 'status?');
  assert.equal(prompt, 'User asked: status?');
});

// ── Project prefix (Web UI direct sessions bound to a project) ──────────────

test('buildConversationPrompt injects a project block naming the project id and context dir', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: 'DIRECTIVE' }), 'hello', {
    project: { id: 'tactile-vr', contextDir: '/ctx/projects/tactile-vr' },
  });
  assert.ok(prompt.includes('tactile-vr'), 'project id must appear in the prompt');
  assert.ok(prompt.includes('/ctx/projects/tactile-vr'), 'project context dir must appear in the prompt');
  // The project block is a prefix: it comes before the user message.
  assert.ok(prompt.indexOf('tactile-vr') < prompt.indexOf('hello'));
  assert.ok(prompt.endsWith('hello'), 'user message stays last');
  assert.ok(!prompt.includes(THREAD_PROTOCOL_PREAMBLE));
});

test('buildConversationPrompt without a project opt injects no project block', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello');
  assert.equal(prompt, 'hello');
});

test('buildConversationPrompt with project:null behaves like no project', () => {
  const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hello', { project: null });
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
