import { beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, DATA_DIR, PROMPTS_DIR } from '../../../src/core/paths.js';

vi.mock('../../../src/domain/agents/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultAgent: (channel?: string) => (channel === 'web:picked' ? 'creative' : null),
}));

const {
  ENVIRONMENTS_DIR, getEnvironment, listEnvironments, loadEnvironments, mergeDefaultEnvironments,
  readEnvironment, resolveAgentSlotConfigByName, saveEnvironment, validateEnvironment,
} = await import('../../../src/domain/agents/environments/index.js');

function seed(name: string, body: unknown): void {
  mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
  writeFileSync(path.join(ENVIRONMENTS_DIR, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

function env(name: string, extra: Record<string, unknown> = {}) {
  return { name, profile: '__active__', persistSession: true, ...extra };
}

beforeEach(() => {
  rmSync(ENVIRONMENTS_DIR, { recursive: true, force: true });
});

describe('environment registry', () => {
  test('lives in config/environments', () => {
    expect(ENVIRONMENTS_DIR).toBe(path.join(CONFIG_DIR, 'environments'));
  });

  test('loads well-formed files and skips malformed or misnamed ones', () => {
    seed('main', env('main'));
    seed('broken', '{ not json');
    seed('alias', env('other'));
    loadEnvironments();
    expect(listEnvironments().map((e) => e.name)).toEqual(['main']);
    expect(getEnvironment('alias')).toBeNull();
  });

  test('resolves file prompt refs and plugin dirs on read, leaving the stored definition raw', () => {
    mkdirSync(path.join(PROMPTS_DIR, 'systemPrompts'), { recursive: true });
    writeFileSync(path.join(PROMPTS_DIR, 'systemPrompts', 'env-test.md'), 'You are a test.');
    seed('main', env('main', { systemPrompt: 'file:env-test.md', pluginDirs: ['plugins/p', '/abs/q'] }));
    loadEnvironments();
    const resolved = getEnvironment('main');
    expect(resolved?.systemPrompt).toBe('You are a test.');
    expect(resolved?.pluginDirs).toEqual([path.join(DATA_DIR, 'plugins/p'), '/abs/q']);
    expect(listEnvironments()[0].systemPrompt).toBe('file:env-test.md');
  });

  test('__active__ resolves through the channel selection, then main', () => {
    seed('main', env('main', { tools: 'Read' }));
    seed('creative', env('creative', { tools: 'Write' }));
    loadEnvironments();
    expect(resolveAgentSlotConfigByName('__active__', 'web:picked')?.slotId).toBe('creative');
    expect(resolveAgentSlotConfigByName('__active__', 'web:other')?.tools).toBe('Read');
    expect(resolveAgentSlotConfigByName('missing')).toBeNull();
  });
});

describe('environment validation and writes', () => {
  test('the thread-control MCP surface and a name mismatch are errors; stages only warn', () => {
    const bad = validateEnvironment('main', env('other', { mcpComposition: 'thread-control' }));
    expect(bad.errors.map((e) => e.path).sort()).toEqual(['mcpComposition', 'name']);
    const staged = validateEnvironment('main', env('main', { stages: { work: { promptTemplate: 'x' } } }));
    expect(staged.errors).toEqual([]);
    expect(staged.warnings.map((w) => w.path)).toContain('stages');
  });

  test('save creates, refuses a stale hash, and never writes an invalid body', () => {
    const created = saveEnvironment(ENVIRONMENTS_DIR, { name: 'c', body: env('c'), baseHash: null });
    expect(created.changed).toBe(true);
    const updated = saveEnvironment(ENVIRONMENTS_DIR, {
      name: 'c', body: env('c', { tools: 'Read' }), baseHash: created.sha256,
    });
    expect(readEnvironment(ENVIRONMENTS_DIR, 'c').body?.tools).toBe('Read');
    expect(() => saveEnvironment(ENVIRONMENTS_DIR, { name: 'c', body: env('c'), baseHash: created.sha256 }))
      .toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => saveEnvironment(ENVIRONMENTS_DIR, { name: 'd', body: { name: 'd' }, baseHash: null }))
      .toThrow(expect.objectContaining({ code: 'invalid-args' }));
    expect(existsSync(path.join(ENVIRONMENTS_DIR, 'd.json'))).toBe(false);
    expect(updated.sha256).not.toBe(created.sha256);
  });

  test('defaults are copied only when missing', () => {
    const defaults = path.join(DATA_DIR, 'tmp', 'env-defaults');
    mkdirSync(defaults, { recursive: true });
    writeFileSync(path.join(defaults, 'main.json'), JSON.stringify(env('main', { tools: 'Shipped' })));
    writeFileSync(path.join(defaults, 'creative.json'), JSON.stringify(env('creative')));
    seed('main', env('main', { tools: 'Mine' }));
    expect(mergeDefaultEnvironments(defaults, ENVIRONMENTS_DIR)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ENVIRONMENTS_DIR, 'main.json'), 'utf8')).tools).toBe('Mine');
    expect(existsSync(path.join(ENVIRONMENTS_DIR, 'creative.json'))).toBe(true);
    expect(mergeDefaultEnvironments(defaults, ENVIRONMENTS_DIR)).toBe(false);
  });
});

test('the shipped environments are exactly main and creative, and both validate', () => {
  const shipped = path.resolve(process.cwd(), 'defaults/config/environments');
  expect(readdirSync(shipped).sort()).toEqual(['creative.json', 'main.json']);
  for (const name of ['main', 'creative']) {
    const body = JSON.parse(readFileSync(path.join(shipped, `${name}.json`), 'utf8'));
    expect(validateEnvironment(name, body).errors).toEqual([]);
    expect(String(body.promptTemplate ?? '')).not.toContain('artifactPath');
  }
});
