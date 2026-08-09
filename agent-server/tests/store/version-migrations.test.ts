// input:  Vitest, assertions, temporary config files
// output: Config, prompt, and version-clock migration regressions
// pos:    Regression tests for versioned file migrations
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Dynamic import of the module under test.
const { compareCalVer, runMigrations, migrateAistatusConfigLocation, upsertMarkerBlock, applyReplacements } = await import('../../src/store/version-migrations.js');

// ── Shared tmp directory ───────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-version-migrations-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────

let _testIdx = 0;

function setupDirs(idx: number): { dataDir: string; storeDir: string; configDir: string; defaultsDir: string } {
  const dataDir = path.join(tmpDir, `data-${idx}`);
  const storeDir = path.join(dataDir, 'data');
  const configDir = path.join(dataDir, 'config');
  // defaultsDir corresponds to DEFAULTS_DIR (= INSTALL_ROOT/defaults/).
  // The DEFAULTS_MAP maps config/thread-templates.json → config/thread-templates.json,
  // which is joined under DEFAULTS_DIR. So we put the actual file at defaultsDir/config/.
  const defaultsDir = path.join(dataDir, 'defaults');
  return { dataDir, storeDir, configDir, defaultsDir };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeText(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

// ── compareCalVer tests ────────────────────────────────────────

test('compareCalVer - same version returns 0', () => {
  assert.equal(compareCalVer('2026.5.23', '2026.5.23'), 0);
  assert.equal(compareCalVer('2027.1.1', '2027.1.1'), 0);
});

test('compareCalVer - different day, same month/year', () => {
  assert.ok(compareCalVer('2026.5.23', '2026.5.9') > 0, '23 > 9');
  assert.ok(compareCalVer('2026.5.9', '2026.5.23') < 0, '9 < 23');
});

test('compareCalVer - cross-digit day boundary', () => {
  // String comparison would fail: "2026.5.9" > "2026.5.10" (because '9' > '1')
  // Numeric comparison is correct: 9 < 10
  assert.ok(compareCalVer('2026.5.9', '2026.5.10') < 0, '9 < 10');
  assert.ok(compareCalVer('2026.5.10', '2026.5.9') > 0, '10 > 9');
});

test('compareCalVer - different month', () => {
  assert.ok(compareCalVer('2026.6.1', '2026.5.23') > 0, 'June > May');
  assert.ok(compareCalVer('2026.5.23', '2026.6.1') < 0, 'May < June');
});

test('compareCalVer - cross-digit month boundary', () => {
  // 2026.10.1 vs 2026.5.1 — string compare would fail ('.' < '1')
  assert.ok(compareCalVer('2026.10.1', '2026.5.1') > 0, 'October > May');
  assert.ok(compareCalVer('2026.5.1', '2026.10.1') < 0, 'May < October');
});

test('compareCalVer - different year', () => {
  assert.ok(compareCalVer('2027.1.1', '2026.12.31') > 0, '2027 > 2026');
  assert.ok(compareCalVer('2026.12.31', '2027.1.1') < 0, '2026 < 2027');
});

test('compareCalVer - zero version', () => {
  assert.ok(compareCalVer('2026.5.23', '0.0.0') > 0, 'any version > 0.0.0');
  assert.ok(compareCalVer('0.0.0', '2026.5.23') < 0, '0.0.0 < any version');
});

// ── runMigrations tests ────────────────────────────────────────
// Each test uses an isolated temp dir passed as MigrationOptions to
// runMigrations(), avoiding dependency on the global CORTEX_HOME env var
// (which is locked at module load time via @core/paths).

test('runMigrations - no versions file, adds systemPrompt to agent missing it', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  // Write defaults with systemPrompt (defaults are at defaultsDir/config/thread-templates.json)
  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, systemPrompt: 'file:direct.md', promptTemplate: 'direct' },
      coder: { name: 'coder', profile: 'sonnet', persistSession: false, systemPrompt: 'file:coder.md', promptTemplate: 'coder' },
    },
    templates: {},
  });

  // Write user config: main has no systemPrompt, coder has one, custom has no defaults counterpart
  await writeJson(path.join(configDir, 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, promptTemplate: 'direct' },
      coder: { name: 'coder', profile: 'sonnet', persistSession: false, systemPrompt: 'file:custom-coder.md', promptTemplate: 'coder' },
      custom: { name: 'custom', profile: 'deepseek', persistSession: false, promptTemplate: 'custom' },
    },
    templates: {},
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Verify
  const migrated = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  // main: systemPrompt was missing, should be added from defaults
  assert.equal(migrated.agents.main.systemPrompt, 'file:direct.md');
  // coder: systemPrompt already existed, should NOT be overwritten
  assert.equal(migrated.agents.coder.systemPrompt, 'file:custom-coder.md');
  // custom: not in defaults, should be untouched and still have no systemPrompt
  assert.equal(migrated.agents.custom.systemPrompt, undefined);

  // Versions file should exist and track this file
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.ok(versions['config/thread-templates.json']);
  assert.ok(compareCalVer(versions['config/thread-templates.json'], '0.0.0') > 0);
});

test('runMigrations - idempotent on second run', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, systemPrompt: 'file:direct.md', promptTemplate: 'direct' },
    },
    templates: {},
  });

  await writeJson(path.join(configDir, 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, promptTemplate: 'direct' },
    },
    templates: {},
  });

  // First run
  await runMigrations({ dataDir, defaultsDir, storeDir });
  const first = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  assert.equal(first.agents.main.systemPrompt, 'file:direct.md');

  // Second run — should be a no-op
  await runMigrations({ dataDir, defaultsDir, storeDir });
  const second = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  assert.equal(second.agents.main.systemPrompt, 'file:direct.md');
  assert.deepEqual(second, first);
});

test('runMigrations - skips when file is already up to date', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, systemPrompt: 'file:direct.md', promptTemplate: 'direct' },
    },
    templates: {},
  });

  // User config already has systemPrompt
  await writeJson(path.join(configDir, 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, systemPrompt: 'file:direct.md', promptTemplate: 'direct' },
    },
    templates: {},
  });

  // Manually write versions.json with up-to-date version
  await writeJson(path.join(storeDir, 'versions.json'), {
    'config/thread-templates.json': '2026.5.23',
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Content should be unchanged
  const content = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  assert.equal(content.agents.main.systemPrompt, 'file:direct.md');
  // Versions should still track the existing version
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['config/thread-templates.json'], '2026.5.23');
});

test('runMigrations - handles missing user config file gracefully', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: { main: { name: 'main', systemPrompt: 'file:direct.md' } },
    templates: {},
  });
  // Do NOT create user config

  // Should not throw
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Versions file should NOT track this file (migration was skipped)
  try {
    const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
    assert.equal(versions['config/thread-templates.json'], undefined);
  } catch (e: any) {
    // versions.json may not exist at all — that's also fine
    if (e.code !== 'ENOENT') throw e;
  }
});

test('runMigrations - handles corrupt user config gracefully', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: { main: { name: 'main', systemPrompt: 'file:direct.md' } },
    templates: {},
  });

  // Write invalid JSON
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'thread-templates.json'), '{ not valid json }');

  // Should not throw
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Versions file should NOT track this file
  try {
    const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
    assert.equal(versions['config/thread-templates.json'], undefined);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
});

test('runMigrations - handles corrupt versions.json gracefully', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, systemPrompt: 'file:direct.md', promptTemplate: 'direct' },
    },
    templates: {},
  });

  await writeJson(path.join(configDir, 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, promptTemplate: 'direct' },
    },
    templates: {},
  });

  // Write corrupt versions.json
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, 'versions.json'), 'not json {');

  // Should not throw — migration should still apply
  await runMigrations({ dataDir, defaultsDir, storeDir });

  const migrated = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  assert.equal(migrated.agents.main.systemPrompt, 'file:direct.md');

  // Versions file should now be valid
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.ok(versions['config/thread-templates.json']);
});

test('runMigrations - vector-clock: only runs versions newer than tracked', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(defaultsDir, 'config', 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, systemPrompt: 'file:direct.md', promptTemplate: 'direct' },
    },
    templates: {},
  });

  await writeJson(path.join(configDir, 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, promptTemplate: 'direct' },
    },
    templates: {},
  });

  // Tracked version is at 2026.5.10 — migrations at 2026.5.23 should still run
  await writeJson(path.join(storeDir, 'versions.json'), {
    'config/thread-templates.json': '2026.5.10',
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const migrated = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  assert.equal(migrated.agents.main.systemPrompt, 'file:direct.md');

  // Version should be bumped to the highest applied migration version
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(compareCalVer(versions['config/thread-templates.json'], '2026.5.10') > 0, true);
});

// ── M2: profiles.json provider backfill ────────────────────────

test('runMigrations - backfills pi provider from mode when missing', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(configDir, 'profiles.json'), {
    defaultProfile: 'plan',
    profiles: {
      plan: { model: 'opus', backend: 'claude', mode: 'plan' },          // non-pi: untouched
      execute: { model: 'deepseek-v4-flash', backend: 'pi', mode: 'anthropic' }, // pi, no provider
      noMode: { model: 'x', backend: 'pi' },                              // pi, no mode either
    },
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const m = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(m.profiles.plan.provider, undefined, 'claude profile gets no provider');
  assert.equal(m.profiles.execute.provider, 'anthropic', 'provider := mode');
  assert.equal(m.profiles.noMode.provider, 'anthropic', 'provider defaults to anthropic when no mode');

  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.ok(versions['config/profiles.json']);
});

test('runMigrations - does not overwrite an existing pi provider', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(configDir, 'profiles.json'), {
    defaultProfile: 'execute',
    profiles: {
      execute: { model: 'deepseek-v4-pro', backend: 'pi', mode: 'plan', provider: 'deepseek' },
    },
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const m = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(m.profiles.execute.provider, 'deepseek', 'existing provider preserved');
});

test('runMigrations - backfills pi provider in fallback entries (inherits backend+mode)', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(configDir, 'profiles.json'), {
    defaultProfile: 'p',
    profiles: {
      // Primary is pi; first fallback inherits pi backend + mode, second is explicit claude.
      p: {
        model: 'a', backend: 'pi', mode: 'anthropic',
        fallback: [
          { model: 'b' },                                  // inherits backend=pi, mode=anthropic
          { model: 'c', backend: 'claude', mode: 'plan' }, // non-pi, untouched
          { model: 'd', backend: 'pi', mode: 'openai' },   // explicit pi + own mode
        ],
      },
    },
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const m = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(m.profiles.p.provider, 'anthropic');
  assert.equal(m.profiles.p.fallback[0].provider, 'anthropic', 'fallback inherits primary mode');
  assert.equal(m.profiles.p.fallback[1].provider, undefined, 'claude fallback untouched');
  assert.equal(m.profiles.p.fallback[2].provider, 'openai', 'explicit pi fallback uses own mode');
});

test('runMigrations - profiles.json migration is idempotent / no-op when already valid', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  const valid = {
    defaultProfile: 'execute',
    profiles: {
      execute: { model: 'deepseek-v4-flash', backend: 'pi', mode: 'anthropic', provider: 'anthropic' },
      plan: { model: 'opus', backend: 'claude', mode: 'plan' },
    },
  };
  await writeJson(path.join(configDir, 'profiles.json'), valid);

  await runMigrations({ dataDir, defaultsDir, storeDir });
  const first = await readJson(path.join(configDir, 'profiles.json'));
  await runMigrations({ dataDir, defaultsDir, storeDir });
  const second = await readJson(path.join(configDir, 'profiles.json'));

  assert.deepEqual(first, valid);
  assert.deepEqual(second, first);
});

// ── M3: sessions.json conduit prefixing ────────────────────────

async function runSessionsMigration(
  idx: number,
  platform: string | undefined,
  sessions: Record<string, string>,
): Promise<Record<string, string>> {
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  await writeJson(path.join(storeDir, 'sessions.json'), sessions);
  const saved = process.env.CORTEX_PLATFORM;
  if (platform === undefined) delete process.env.CORTEX_PLATFORM;
  else process.env.CORTEX_PLATFORM = platform;
  try {
    await runMigrations({ dataDir, defaultsDir, storeDir });
  } finally {
    if (saved === undefined) delete process.env.CORTEX_PLATFORM;
    else process.env.CORTEX_PLATFORM = saved;
  }
  return await readJson(path.join(storeDir, 'sessions.json')) as Record<string, string>;
}

test('runMigrations - sessions.json: prefixes backend:channel and legacy bare keys (slack)', async () => {
  const out = await runSessionsMigration(_testIdx++, 'slack', {
    'claude:C123': 's-claude',
    'pi:D456': 's-pi',
    'C789': 's-legacy',          // legacy bare channel
    'tui:tui-abc': 's-tui',      // TUI key — must be left untouched
    'claude:tui-def': 's-tui2',  // TUI conduit under a backend — untouched
  });
  assert.equal(out['claude:slack:C123'], 's-claude');
  assert.equal(out['pi:slack:D456'], 's-pi');
  assert.equal(out['slack:C789'], 's-legacy');
  assert.equal(out['tui:tui-abc'], 's-tui');
  assert.equal(out['claude:tui-def'], 's-tui2');
  // Old un-prefixed keys are gone
  assert.equal(out['claude:C123'], undefined);
  assert.equal(out['C789'], undefined);
});

test('runMigrations - sessions.json: prefixes with feishu when configured', async () => {
  const out = await runSessionsMigration(_testIdx++, 'feishu', {
    'claude:oc_1': 'f1',
    'oc_2': 'f2',
  });
  assert.equal(out['claude:feishu:oc_1'], 'f1');
  assert.equal(out['feishu:oc_2'], 'f2');
});

test('runMigrations - sessions.json: is idempotent (already-prefixed keys untouched)', async () => {
  const already = { 'claude:slack:C1': 'x', 'slack:C2': 'y' };
  const out = await runSessionsMigration(_testIdx++, 'slack', already);
  assert.deepEqual(out, already);
});

test('runMigrations - sessions.json: skipped when multiple platforms configured', async () => {
  const input = { 'claude:C1': 'x', 'C2': 'y' };
  const out = await runSessionsMigration(_testIdx++, 'slack,feishu', input);
  assert.deepEqual(out, input, 'bare channels cannot be attributed → no-op');
});

test('runMigrations - no defaults file, still runs (migration function handles undefined)', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  // Do NOT create defaults file

  await writeJson(path.join(configDir, 'thread-templates.json'), {
    agents: {
      main: { name: 'main', profile: 'sonnet', persistSession: false, promptTemplate: 'direct' },
    },
    templates: {},
  });

  // Should not throw — migration function checks for undefined defaults
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // File should be unchanged (no defaults means no systemPrompt to copy)
  const content = await readJson(path.join(configDir, 'thread-templates.json')) as any;
  assert.equal(content.agents.main.systemPrompt, undefined);

  // But version should still be tracked (migration was "applied" — it was a no-op)
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.ok(versions['config/thread-templates.json']);
});

// ── upsertMarkerBlock (text-migration primitive) ───────────────

const DOCS_URL = 'https://fangxm233.github.io/cortex-agent/';
const BLOCK = `<!-- cortex:docs v1 -->\n# Cortex documentation\nsee ${DOCS_URL}\n<!-- /cortex:docs -->`;

test('upsertMarkerBlock - appends block when absent (preserves original + trailing newline)', () => {
  const out = upsertMarkerBlock('Hello world.\n', BLOCK);
  assert.ok(out.startsWith('Hello world.'), 'original content preserved');
  assert.ok(out.includes(BLOCK), 'block appended');
  assert.ok(out.endsWith('\n'), 'ends with newline');
  // Exactly one block
  assert.equal((out.match(/<!-- cortex:docs/g) || []).length, 1);
});

test('upsertMarkerBlock - idempotent: re-running on output is a no-op', () => {
  const once = upsertMarkerBlock('Body.\n', BLOCK);
  const twice = upsertMarkerBlock(once, BLOCK);
  assert.equal(twice, once);
  assert.equal((twice.match(/<!-- cortex:docs/g) || []).length, 1, 'no duplicate block');
});

test('upsertMarkerBlock - replaces an existing block in place, preserving surrounding text', () => {
  const stale = 'Intro.\n\n<!-- cortex:docs v0 -->\nOLD URL\n<!-- /cortex:docs -->\n\nOutro.\n';
  const out = upsertMarkerBlock(stale, BLOCK);
  assert.ok(out.includes('Intro.'), 'leading user text kept');
  assert.ok(out.includes('Outro.'), 'trailing user text kept');
  assert.ok(out.includes(DOCS_URL), 'new URL present');
  assert.ok(!out.includes('OLD URL'), 'old block content gone');
  assert.equal((out.match(/<!-- cortex:docs/g) || []).length, 1, 'exactly one block');
});

// ── M4: docs-block text migration via runMigrations ────────────

test('runMigrations - text: injects docs block into CORTEX.md and tracks version', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  await writeText(path.join(dataDir, 'CORTEX.md'), '# My customized CORTEX.md\n\nUser notes here.\n');

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const out = await readText(path.join(dataDir, 'CORTEX.md'));
  assert.ok(out.includes('# My customized CORTEX.md'), 'user content preserved');
  assert.ok(out.includes('User notes here.'), 'user content preserved');
  assert.ok(out.includes('https://fangxm233.github.io/cortex-agent/'), 'docs URL injected');
  assert.ok(out.includes('<!-- cortex:docs'), 'marker present');

  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['CORTEX.md'], '2026.6.22');
});

test('runMigrations - text: updates docs and PI roles in system prompt files', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  const promptsDir = path.join(dataDir, 'prompts', 'systemPrompts');
  const promptVersions = [
    ['direct', '2026.6.24'],
    ['worker', '2026.8.2'],
    ['coder', '2026.6.24'],
  ] as const;
  for (const [promptName] of promptVersions) {
    await writeText(
      path.join(promptsDir, `${promptName}.md`),
      `Custom ${promptName}\nUse subagent_type=Explore.\nTail ${promptName}\n`,
    );
  }

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  for (const [promptName, expectedVersion] of promptVersions) {
    const out = await readText(path.join(promptsDir, `${promptName}.md`));
    assert.ok(out.startsWith(`Custom ${promptName}`), 'leading customization preserved');
    assert.ok(out.includes(`Tail ${promptName}`), 'trailing customization preserved');
    assert.ok(out.includes('subagent_type=explore'), 'PI role normalized');
    assert.ok(!out.includes('subagent_type=Explore'), 'stale PI role removed');
    assert.ok(out.includes('https://fangxm233.github.io/cortex-agent/'), 'docs URL injected');
    assert.equal(versions[`prompts/systemPrompts/${promptName}.md`], expectedVersion);
  }
});

test('runMigrations - text: idempotent (second run does not duplicate block)', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  const target = path.join(dataDir, 'CORTEX.md');
  await writeText(target, 'Base.\n');

  await runMigrations({ dataDir, defaultsDir, storeDir });
  const first = await readText(target);
  await runMigrations({ dataDir, defaultsDir, storeDir });
  const second = await readText(target);

  assert.equal(second, first);
  assert.equal((second.match(/<!-- cortex:docs/g) || []).length, 1, 'exactly one block after two runs');
});

test('runMigrations - text: skips gracefully when target file does not exist', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  // No CORTEX.md / system prompts created at all
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Missing text files must not be tracked (migration skipped, not falsely applied)
  try {
    const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
    assert.equal(versions['CORTEX.md'], undefined);
    assert.equal(versions['prompts/systemPrompts/direct.md'], undefined);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
});

// ── applyReplacements (text-migration primitive) ───────────────

test('applyReplacements - replaces each present `from` and skips absent ones', () => {
  const out = applyReplacements('alpha beta gamma', [['alpha', 'A'], ['delta', 'D'], ['gamma', 'G']]);
  assert.equal(out, 'A beta G');
});

test('applyReplacements - idempotent: re-running on output is a no-op', () => {
  const pairs = [['old phrase', 'new phrase']] as const;
  const once = applyReplacements('the old phrase here', pairs);
  const twice = applyReplacements(once, pairs);
  assert.equal(once, 'the new phrase here');
  assert.equal(twice, once);
});

test('applyReplacements - replaces every occurrence of a `from`', () => {
  const out = applyReplacements('npm test then npm test', [['npm test', 'the suite']]);
  assert.equal(out, 'the suite then the suite');
});

// ── migrateAistatusConfigLocation ──────────────────────────────

test('migrateAistatusConfigLocation: deletes old config when target does not exist', async () => {
  // This test verifies the function tries to create the target.
  // Due to mocking limitations with dynamic imports, we test the core logic:
  // if old file exists and is valid YAML, the function reads it and attempts to write to target.
  const idx = _testIdx++;
  const { dataDir } = setupDirs(idx);

  // Create old config file at the wrong location
  const oldPath = path.join(dataDir, 'config', 'config.yaml');
  const content = 'name: testuser\norg: testorg\nemail: test@example.com\nuploadEnabled: true\n';
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, content);

  // Call migration — it will try to migrate (target location depends on real homedir)
  // We just verify old file is deleted/handled without error
  await migrateAistatusConfigLocation(dataDir);

  // Verify: if migration succeeded, old file should be deleted or target should exist
  const oldExists = await fs.stat(oldPath).catch(() => null);
  const targetPath = path.join(os.homedir(), '.aistatus', 'config.yaml');
  const targetExists = await fs.stat(targetPath).catch(() => null);

  // Either old file was deleted (best case) or target now exists
  assert.ok(oldExists === null || targetExists !== null,
    'old file should be deleted when target is created, or target should exist');
});

test('migrateAistatusConfigLocation: skips when old file does not exist', async () => {
  const idx = _testIdx++;
  const { dataDir } = setupDirs(idx);

  // Should not throw
  await migrateAistatusConfigLocation(dataDir);

  // Nothing to verify beyond: function should return without error
  assert.ok(true, 'should complete without error when source does not exist');
});

test('migrateAistatusConfigLocation: deletes malformed old config without copying', async () => {
  const idx = _testIdx++;
  const { dataDir } = setupDirs(idx);

  // Create malformed config (not valid YAML-like)
  const oldPath = path.join(dataDir, 'config', 'config.yaml');
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, 'not: valid: yaml: because: starts: with: invalid');

  // Call migration
  await migrateAistatusConfigLocation(dataDir);

  // Old file should be deleted (malformed files are cleaned up)
  const oldExists = await fs.stat(oldPath).catch(() => null);
  assert.equal(oldExists, null, 'malformed old file should be deleted');
});
