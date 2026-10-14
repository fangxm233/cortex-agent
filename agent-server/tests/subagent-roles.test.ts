import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  DEFAULT_AGENT_ROLES_DIR,
  adoptLegacyAgentRoles,
  loadRoles,
  parseRole,
  roleToolsForBackend,
  type AgentRole,
} from '@core/agents/roles.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-roles-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function role(overrides: Partial<AgentRole> = {}): AgentRole {
  return { name: 'r', description: 'd', systemPrompt: '', ...overrides };
}

// --- frontmatter ---

test('parseRole reads the unified fields, including backend and mode', () => {
  const parsed = parseRole([
    '---',
    'name: scout',
    'description: look around',
    'tools: read, grep',
    'model: deepseek/deepseek-chat:high',
    'backend: pi',
    'mode: deepseek',
    '---',
    '',
    'Go look.',
  ].join('\n'));
  assert.deepEqual(parsed, {
    name: 'scout',
    description: 'look around',
    tools: ['read', 'grep'],
    model: 'deepseek/deepseek-chat:high',
    backend: 'pi',
    mode: 'deepseek',
    systemPrompt: 'Go look.',
  });
});

test('parseRole accepts a YAML list for tools and leaves the optional fields undefined', () => {
  const parsed = parseRole('---\nname: a\ndescription: b\ntools:\n  - read\n  - bash\n---\nbody')!;
  assert.deepEqual(parsed.tools, ['read', 'bash']);
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.backend, undefined);
  assert.equal(parsed.mode, undefined);
});

test('parseRole ignores a backend that is not a real one, rather than trusting it', () => {
  const parsed = parseRole('---\nname: a\ndescription: b\nbackend: gpt\n---\nbody')!;
  assert.equal(parsed.backend, undefined);
});

test('parseRole rejects a file that is not a role', () => {
  assert.equal(parseRole('just prose, no frontmatter'), null);
  assert.equal(parseRole('---\ndescription: no name\n---\nbody'), null);
  assert.equal(parseRole('---\nname: no description\n---\nbody'), null);
});

// --- per-backend tool translation ---

test('roleToolsForBackend translates canonical names into each backend\'s own spelling', () => {
  const tools = ['read', 'grep', 'bash'];
  assert.deepEqual(roleToolsForBackend(role({ tools }), 'claude'), ['Read', 'Grep', 'Bash']);
  assert.deepEqual(roleToolsForBackend(role({ tools }), 'pi'), ['read', 'grep', 'bash']);
});

test('roleToolsForBackend prefixes a bare MCP tool for claude and leaves it bare for pi', () => {
  const tools = ['current_time'];
  assert.deepEqual(roleToolsForBackend(role({ tools }), 'claude'), ['mcp__cortex-core__current_time']);
  assert.deepEqual(roleToolsForBackend(role({ tools }), 'pi'), ['current_time']);
});

test('roleToolsForBackend passes an already-prefixed MCP name through on both backends', () => {
  const tools = ['mcp__cortex-core__current_time'];
  for (const backend of ['claude', 'pi'] as const) {
    assert.deepEqual(roleToolsForBackend(role({ tools }), backend), ['mcp__cortex-core__current_time']);
  }
});

test('roleToolsForBackend drops a name claude does not know but keeps it for pi', () => {
  // `ls` is a real PI tool with no Claude counterpart; `--tools` would reject it.
  const tools = ['read', 'ls'];
  assert.deepEqual(roleToolsForBackend(role({ tools }), 'claude'), ['Read']);
  assert.deepEqual(roleToolsForBackend(role({ tools }), 'pi'), ['read', 'ls']);
});

test('roleToolsForBackend de-duplicates and returns undefined for a role with no tool list', () => {
  assert.deepEqual(roleToolsForBackend(role({ tools: ['read', 'Read', 'read'] }), 'claude'), ['Read']);
  assert.equal(roleToolsForBackend(role(), 'claude'), undefined);
});

// --- lookup ---

// --- built-in layer and migration ---

test('loadRoles reads the shipped roles in place when the user has none', () => {
  const rolesDir = path.join(tempDir(), 'agents');
  const names = loadRoles(rolesDir).map(r => r.name).sort();
  assert.deepEqual(names, ['explore', 'general-purpose', 'plan']);
  assert.equal(fs.existsSync(rolesDir), false, 'nothing is copied into the home');
});

test('a user role file overrides the built-in of the same name, and deleting it reverts', () => {
  const rolesDir = path.join(tempDir(), 'agents');
  fs.mkdirSync(rolesDir);
  const mine = path.join(rolesDir, 'explore.md');
  fs.writeFileSync(mine, '---\nname: explore\ndescription: mine\n---\nmy prompt');
  fs.writeFileSync(path.join(rolesDir, 'extra.md'), '---\nname: extra\ndescription: d\n---\nbody');
  const roles = loadRoles(rolesDir);
  assert.equal(roles.find(r => r.name === 'explore')?.systemPrompt, 'my prompt');
  assert.ok(roles.some(r => r.name === 'extra'));
  assert.equal(roles.filter(r => r.name === 'explore').length, 1);

  fs.rmSync(mine);
  assert.notEqual(loadRoles(rolesDir).find(r => r.name === 'explore')?.systemPrompt, 'my prompt');
});

test('a user file reusing a built-in role name under another file name wins', () => {
  const rolesDir = tempDir();
  fs.writeFileSync(path.join(rolesDir, 'my-plan.md'), '---\nname: plan\ndescription: mine\n---\nmine');
  const plans = loadRoles(rolesDir).filter(r => r.name === 'plan');
  assert.deepEqual(plans.map(r => r.systemPrompt), ['mine']);
});

test('adoptLegacyAgentRoles adopts a legacy PI role dir once and then retires it', () => {
  const home = tempDir();
  const rolesDir = path.join(home, 'agents');
  const legacyDir = path.join(home, 'pi', 'agents');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'mine.md'), '---\nname: mine\ndescription: legacy\n---\nbody');
  fs.copyFileSync(path.join(DEFAULT_AGENT_ROLES_DIR, 'plan.md'), path.join(legacyDir, 'plan.md'));

  adoptLegacyAgentRoles({ rolesDir, defaultsDir: DEFAULT_AGENT_ROLES_DIR, legacyDir });
  assert.ok(loadRoles(rolesDir).some(r => r.name === 'mine'), 'legacy role was adopted');
  assert.equal(fs.existsSync(path.join(rolesDir, 'plan.md')), false, 'a stock copy is not pinned');
  // Renamed aside, so an edit made there can no longer look live.
  assert.equal(fs.existsSync(legacyDir), false);
  assert.ok(fs.existsSync(`${legacyDir}.migrated`));

  // Second run does nothing: a role deleted after migration stays deleted.
  fs.rmSync(path.join(rolesDir, 'mine.md'));
  adoptLegacyAgentRoles({ rolesDir, defaultsDir: DEFAULT_AGENT_ROLES_DIR, legacyDir });
  assert.equal(loadRoles(rolesDir).some(r => r.name === 'mine'), false);
});

test('loadRoles skips non-markdown and unparseable files, and tolerates a missing dir', () => {
  const rolesDir = tempDir();
  fs.writeFileSync(path.join(rolesDir, 'good.md'), '---\nname: good\ndescription: d\n---\nbody');
  fs.writeFileSync(path.join(rolesDir, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(rolesDir, 'broken.md'), 'no frontmatter');
  assert.deepEqual(loadRoles(rolesDir, null).map(r => r.name), ['good']);
  assert.deepEqual(loadRoles(path.join(rolesDir, 'gone'), null), []);
});
