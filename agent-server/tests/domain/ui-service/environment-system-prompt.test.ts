import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, PROMPTS_DIR } from '../../../src/core/paths.js';
import { handleEnvironmentsSavePrompt } from '../../../src/domain/ui-service/mutate/environments.js';
import { handleEnvironmentsGet } from '../../../src/domain/ui-service/query/environments.js';
import { mutateInputSchemas } from '../../../src/domain/ui-service/input-schemas.js';
import { makeUiDeps } from './ui-deps-fixture.js';

// CONFIG_DIR and PROMPTS_DIR already point into the isolated temp home the vitest setup creates.
const ENV_DIR = path.join(CONFIG_DIR, 'environments');
const PROMPT_DIR = path.join(PROMPTS_DIR, 'systemPrompts');

function seedEnvironment(name: string, extra: Record<string, unknown> = {}): void {
  const body = { name, profile: 'plan', tools: 'Read', ...extra };
  writeFileSync(path.join(ENV_DIR, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function readBody(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ENV_DIR, `${name}.json`), 'utf8'));
}

function seedPrompt(file: string, text: string): void {
  writeFileSync(path.join(PROMPT_DIR, file), text, 'utf8');
}

const deps = () => makeUiDeps();
const save = (name: string, text: string) => handleEnvironmentsSavePrompt(deps(), { name, text });

beforeEach(() => {
  rmSync(ENV_DIR, { recursive: true, force: true });
  rmSync(PROMPT_DIR, { recursive: true, force: true });
  mkdirSync(ENV_DIR, { recursive: true });
  mkdirSync(PROMPT_DIR, { recursive: true });
});

describe('environments.get systemPrompt', () => {
  test('a file ref reports its text, the environments sharing it, and the shipped copy', async () => {
    seedEnvironment('a', { systemPrompt: 'file:direct.md' });
    seedEnvironment('b', { systemPrompt: 'file:direct.md' });
    seedEnvironment('c', { systemPrompt: 'file:other.md' });
    seedPrompt('direct.md', 'edited prompt');

    const { systemPrompt } = await handleEnvironmentsGet(deps(), { name: 'a' });
    assert.equal(systemPrompt.kind, 'file');
    assert.equal(systemPrompt.file, 'direct.md');
    assert.equal(systemPrompt.text, 'edited prompt');
    assert.deepEqual(systemPrompt.sharedWith, ['b']);
    assert.match(systemPrompt.defaultText ?? '', /^You are Cortex/);
  });

  test('a missing prompt file reads as empty text', async () => {
    seedEnvironment('a', { systemPrompt: 'file:gone.md' });
    const { systemPrompt } = await handleEnvironmentsGet(deps(), { name: 'a' });
    assert.equal(systemPrompt.text, '');
    assert.equal(systemPrompt.defaultText, null);
  });

  test('a literal and an absent field are inline and none', async () => {
    seedEnvironment('lit', { systemPrompt: 'Be brief.' });
    seedEnvironment('bare');
    const lit = (await handleEnvironmentsGet(deps(), { name: 'lit' })).systemPrompt;
    const bare = (await handleEnvironmentsGet(deps(), { name: 'bare' })).systemPrompt;
    assert.deepEqual([lit.kind, lit.text, lit.file], ['inline', 'Be brief.', null]);
    assert.deepEqual([bare.kind, bare.text, bare.file], ['none', '', null]);
  });
});

describe('environments.savePrompt', () => {
  test('a file ref is rewritten in place and the environment file is left alone', async () => {
    seedEnvironment('a', { systemPrompt: 'file:a-prompt.md' });
    seedPrompt('a-prompt.md', 'old');
    const before = readFileSync(path.join(ENV_DIR, 'a.json'), 'utf8');

    const result = await save('a', 'new prompt\n');
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.data, { changed: true, file: 'a-prompt.md' });
    assert.equal(readFileSync(path.join(PROMPT_DIR, 'a-prompt.md'), 'utf8'), 'new prompt\n');
    assert.equal(readFileSync(path.join(ENV_DIR, 'a.json'), 'utf8'), before);
  });

  test('saving the same text again reports no change', async () => {
    seedEnvironment('a', { systemPrompt: 'file:a-prompt.md' });
    seedPrompt('a-prompt.md', 'same');
    const result = await save('a', 'same');
    assert.ok(result.ok);
    assert.equal(result.data.changed, false);
  });

  test('an environment without a prompt gets <name>.md and a ref to it', async () => {
    seedEnvironment('bare');
    const result = await save('bare', 'Fresh prompt');
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.data, { changed: true, file: 'bare.md' });
    assert.equal(readFileSync(path.join(PROMPT_DIR, 'bare.md'), 'utf8'), 'Fresh prompt');
    assert.equal(readBody('bare').systemPrompt, 'file:bare.md');
  });

  test('a literal moves to a file and keeps its key position', async () => {
    seedEnvironment('lit', { systemPrompt: 'Be brief.', description: 'after' });
    const result = await save('lit', 'Be thorough.');
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(Object.keys(readBody('lit')), ['name', 'profile', 'tools', 'systemPrompt', 'description']);
    assert.equal(readBody('lit').systemPrompt, 'file:lit.md');
  });

  test('empty text clears a literal back to the backend default', async () => {
    seedEnvironment('lit', { systemPrompt: 'Be brief.' });
    const result = await save('lit', '  ');
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.data, { changed: true, file: null });
    assert.equal('systemPrompt' in readBody('lit'), false);
    assert.equal(existsSync(path.join(PROMPT_DIR, 'lit.md')), false);
  });

  test('refuses to take over a file another environment already uses', async () => {
    seedEnvironment('x');
    seedEnvironment('y', { systemPrompt: 'file:x.md' });
    seedPrompt('x.md', 'belongs to y');

    const result = await save('x', 'mine');
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'conflict');
    assert.match((result as { message: string }).message, /y/);
    assert.equal(readFileSync(path.join(PROMPT_DIR, 'x.md'), 'utf8'), 'belongs to y');
    assert.equal('systemPrompt' in readBody('x'), false);
  });

  test('a ref that escapes the prompt directory is refused', async () => {
    seedEnvironment('a', { systemPrompt: 'file:../escape.md' });
    const result = await save('a', 'payload');
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'invalid-args');
    assert.equal(existsSync(path.join(PROMPTS_DIR, 'escape.md')), false);
  });

  test('an unknown environment is not-found', async () => {
    const result = await save('ghost', 'text');
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'not-found');
  });

  test('the input caps the prompt length', () => {
    const schema = mutateInputSchemas['environments.savePrompt'];
    assert.doesNotThrow(() => schema.parse({ name: 'a', text: 'x'.repeat(65_536) }));
    assert.throws(() => schema.parse({ name: 'a', text: 'x'.repeat(65_537) }));
  });
});
