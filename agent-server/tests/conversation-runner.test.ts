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
import type { AgentSlotConfig } from '../src/core/types/thread-types.js';

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
