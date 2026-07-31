// input:  user context, prompt builder, filesystem, settings
// output: profile injection and settings reset regressions
// pos:    Covers settings-gated USER.md prompt injection
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONTEXT_DIR } from '../src/core/utils.js';
import { loadUserContext } from '../src/domain/memory/user-context.js';
import { buildConversationPrompt } from '../src/domain/threads/prompt-builder.js';
import type { AgentSlotConfig } from '../src/core/types/thread-types.js';
import { resetSettingsForTests } from '../src/core/settings.js';

const USER_DIR = path.join(CONTEXT_DIR, 'user');
const USER_MD = path.join(USER_DIR, 'USER.md');
const SAMPLE = '# User Profile\n- Name: Test User\n- Language: 中文\n';

function writeUser(content: string): void {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(USER_MD, content);
}
function removeUser(): void {
  try { fs.unlinkSync(USER_MD); } catch {}
}

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

test('loadUserContext wraps USER.md content when the file exists', () => {
  writeUser(SAMPLE);
  delete process.env.CORTEX_DISABLE_USER_CONTEXT;
  assert.equal(loadUserContext(), `[User Context]\n${SAMPLE}\n[/User Context]`);
});

test('loadUserContext returns null when CORTEX_DISABLE_USER_CONTEXT=1', async () => {
  writeUser(SAMPLE);
  process.env.CORTEX_DISABLE_USER_CONTEXT = '1';
  try {
    resetSettingsForTests();
    assert.equal(loadUserContext(), null);
  } finally {
    delete process.env.CORTEX_DISABLE_USER_CONTEXT;
    resetSettingsForTests();
  }
});

test('loadUserContext returns null when USER.md is absent', () => {
  removeUser();
  delete process.env.CORTEX_DISABLE_USER_CONTEXT;
  assert.equal(loadUserContext(), null);
});

test('buildConversationPrompt prepends [User Context] when USER.md exists', () => {
  writeUser(SAMPLE);
  delete process.env.CORTEX_DISABLE_USER_CONTEXT;
  try {
    const prompt = buildConversationPrompt(makeAgentConfig({ directive: 'You are direct.' }), 'hi');
    assert.ok(prompt.startsWith('[User Context]'), 'user context must be the first prefix');
    assert.ok(prompt.includes('Name: Test User'));
    assert.ok(prompt.includes('You are direct.'));
    assert.ok(prompt.includes('hi'));
  } finally {
    removeUser();
  }
});

test('buildConversationPrompt injects user context when includeUserContext is true', () => {
  writeUser(SAMPLE);
  delete process.env.CORTEX_DISABLE_USER_CONTEXT;
  try {
    const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hi', { includeUserContext: true });
    assert.ok(prompt.startsWith('[User Context]'));
    assert.ok(prompt.includes('Name: Test User'));
  } finally {
    removeUser();
  }
});

test('buildConversationPrompt omits user context when includeUserContext is false', () => {
  writeUser(SAMPLE);
  delete process.env.CORTEX_DISABLE_USER_CONTEXT;
  try {
    const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hi', { includeUserContext: false });
    assert.equal(prompt, 'hi');
    assert.ok(!prompt.includes('[User Context]'));
  } finally {
    removeUser();
  }
});

test('buildConversationPrompt omits user context when disabled', async () => {
  writeUser(SAMPLE);
  process.env.CORTEX_DISABLE_USER_CONTEXT = '1';
  try {
    resetSettingsForTests();
    const prompt = buildConversationPrompt(makeAgentConfig({ directive: '' }), 'hi');
    assert.equal(prompt, 'hi');
  } finally {
    delete process.env.CORTEX_DISABLE_USER_CONTEXT;
    resetSettingsForTests();
    removeUser();
  }
});
