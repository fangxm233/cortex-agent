import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Dynamic import of the module under test.
const { compareCalVer, runMigrations, migrateAistatusConfigLocation, upsertMarkerBlock, applyReplacements } = await import('../../src/store/version-migrations.js');
type StepMigration = import('../../src/store/version-migrations.js').StepMigration;

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
  // defaultsDir stands in for DEFAULTS_DIR (= INSTALL_ROOT/defaults/), which the step migrations read.
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

test('compareCalVer - cross-digit day boundary', () => {
  // String comparison would fail: "2026.5.9" > "2026.5.10" (because '9' > '1')
  // Numeric comparison is correct: 9 < 10
  assert.ok(compareCalVer('2026.5.9', '2026.5.10') < 0, '9 < 10');
  assert.ok(compareCalVer('2026.5.10', '2026.5.9') > 0, '10 > 9');
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
//
// The runner tests below use the profiles.json provider backfill (2026.5.25) as their vehicle and
// run without step migrations, so only the file loop is exercised.
const NO_STEPS: never[] = [];
const PROFILES = 'config/profiles.json';
/** A pi profile without a provider: the backfill sets `provider` from `mode`. */
const UNMIGRATED_PROFILES = {
  defaultProfile: 'execute',
  profiles: { execute: { model: 'deepseek-v4-flash', backend: 'pi', mode: 'anthropic' } },
};

test('runMigrations - idempotent on second run', async () => {
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(_testIdx++);
  await writeJson(path.join(configDir, 'profiles.json'), UNMIGRATED_PROFILES);

  await runMigrations({ dataDir, defaultsDir, storeDir, stepMigrations: NO_STEPS });
  const first = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(first.profiles.execute.provider, 'anthropic');

  // Second run — should be a no-op
  await runMigrations({ dataDir, defaultsDir, storeDir, stepMigrations: NO_STEPS });
  assert.deepEqual(await readJson(path.join(configDir, 'profiles.json')), first);
});

test('runMigrations - skips when file is already up to date', async () => {
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(_testIdx++);
  // Running the migration would backfill the provider
  await writeJson(path.join(configDir, 'profiles.json'), UNMIGRATED_PROFILES);
  await writeJson(path.join(storeDir, 'versions.json'), { [PROFILES]: '2026.5.25' });

  await runMigrations({ dataDir, defaultsDir, storeDir, stepMigrations: NO_STEPS });

  // Migration was skipped, so the provider was not backfilled
  const content = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(content.profiles.execute.provider, undefined);
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions[PROFILES], '2026.5.25');
});

test('runMigrations - handles missing user config file gracefully', async () => {
  const { dataDir, storeDir, defaultsDir } = setupDirs(_testIdx++);
  // Do NOT create user config

  // Should not throw
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Versions file should NOT track this file (migration was skipped)
  try {
    const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
    assert.equal(versions[PROFILES], undefined);
  } catch (e: any) {
    // versions.json may not exist at all — that's also fine
    if (e.code !== 'ENOENT') throw e;
  }
});

test('runMigrations - handles corrupt user config gracefully', async () => {
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(_testIdx++);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'profiles.json'), '{ not valid json }');

  // Should not throw
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // The file is left as it was, and its migrations stay pending
  assert.equal(await readText(path.join(configDir, 'profiles.json')), '{ not valid json }');
  try {
    const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
    assert.equal(versions[PROFILES], undefined);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
});

test('runMigrations - handles corrupt versions.json gracefully', async () => {
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(_testIdx++);
  await writeJson(path.join(configDir, 'profiles.json'), UNMIGRATED_PROFILES);
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, 'versions.json'), 'not json {');

  // Should not throw — migration should still apply
  await runMigrations({ dataDir, defaultsDir, storeDir, stepMigrations: NO_STEPS });

  const migrated = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(migrated.profiles.execute.provider, 'anthropic');
  // Versions file should now be valid
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions[PROFILES], '2026.5.25');
});

test('runMigrations - vector-clock: only runs versions newer than tracked', async () => {
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(_testIdx++);
  await writeJson(path.join(configDir, 'profiles.json'), UNMIGRATED_PROFILES);
  // Tracked version is at 2026.5.10 — the migration at 2026.5.25 should still run
  await writeJson(path.join(storeDir, 'versions.json'), { [PROFILES]: '2026.5.10' });

  await runMigrations({ dataDir, defaultsDir, storeDir, stepMigrations: NO_STEPS });

  const migrated = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(migrated.profiles.execute.provider, 'anthropic');
  // Version should be bumped to the highest applied migration version
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions[PROFILES], '2026.5.25');
});

test('runMigrations - a migration that changes nothing leaves the file byte-identical and is still tracked', async () => {
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(_testIdx++);
  const raw = '{"defaultProfile":"plan","profiles":{"plan":{"model":"opus","backend":"claude","mode":"plan"}}}';
  await writeText(path.join(configDir, 'profiles.json'), raw);

  await runMigrations({ dataDir, defaultsDir, storeDir, stepMigrations: NO_STEPS });

  assert.equal(await readText(path.join(configDir, 'profiles.json')), raw);
  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions[PROFILES], '2026.5.25');
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
  // The M3 file migration rewrites sessions.json in place; the S1 step migration then imports it into
  // the registry and renames it to `<file>.pre-<version>.bak`. So the M3 output now lives in the .bak.
  return await readJson(path.join(storeDir, 'sessions.json.pre-2026.9.14.bak')) as Record<string, string>;
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

test('runMigrations - text: injects docs block into AGENTS.md and tracks version', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  await writeText(path.join(dataDir, 'AGENTS.md'), '# My customized AGENTS.md\n\nUser notes here.\n');

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const out = await readText(path.join(dataDir, 'AGENTS.md'));
  assert.ok(out.includes('# My customized AGENTS.md'), 'user content preserved');
  assert.ok(out.includes('User notes here.'), 'user content preserved');
  assert.ok(out.includes('https://fangxm233.github.io/cortex-agent/'), 'docs URL injected');
  assert.ok(out.includes('<!-- cortex:docs v2 -->'), 'current marker present');
  assert.ok(!out.includes('tasks, threads'), 'the block no longer names tasks or threads');

  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['AGENTS.md'], '2026.10.2');
});

test('runMigrations - text: upgrades only the exact stock v1 docs block', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  const v1 = [
    '<!-- cortex:docs v1 -->',
    '# Cortex documentation',
    `For how to use Cortex — tasks, threads, scheduling, memory, skills, safety & approvals — consult the docs: ${DOCS_URL}`,
    '<!-- /cortex:docs -->',
  ].join('\n');
  const custom = `<!-- cortex:docs v1 -->\nMy own docs pointer: ${DOCS_URL}\n<!-- /cortex:docs -->`;
  await writeText(path.join(dataDir, 'AGENTS.md'), `# Mine\n\n${v1}\n`);
  await writeText(path.join(dataDir, 'prompts', 'systemPrompts', 'worker.md'), `Worker\n\n${custom}\n`);
  await writeJson(path.join(storeDir, 'versions.json'), {
    'AGENTS.md': '2026.6.22', 'prompts/systemPrompts/worker.md': '2026.8.2',
  });

  await runMigrations({ dataDir, defaultsDir, storeDir });

  const agents = await readText(path.join(dataDir, 'AGENTS.md'));
  assert.ok(agents.startsWith('# Mine'), 'user content preserved');
  assert.ok(agents.includes('<!-- cortex:docs v2 -->'));
  assert.ok(agents.includes('sessions, scheduling, memory'));
  assert.ok(!agents.includes('tasks, threads'));
  assert.equal(await readText(path.join(dataDir, 'prompts', 'systemPrompts', 'worker.md')), `Worker\n\n${custom}\n`);
});

test('runMigrations - text: updates docs and PI roles in system prompt files', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  const promptsDir = path.join(dataDir, 'prompts', 'systemPrompts');
  const promptVersions = [
    ['direct', '2026.6.24'],
    ['worker', '2026.10.2'],
    ['coder', '2026.10.2'],
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

  const target = path.join(dataDir, 'AGENTS.md');
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

  // No AGENTS.md / system prompts created at all
  await runMigrations({ dataDir, defaultsDir, storeDir });

  // Missing text files must not be tracked (migration skipped, not falsely applied)
  try {
    const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
    assert.equal(versions['AGENTS.md'], undefined);
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

// ── migrateAistatusConfigLocation ──────────────────────────────
// Every call passes a temp target: the default is the real ~/.aistatus/config.yaml.

/** Stand-in for ~/.aistatus/config.yaml inside the test's own temp dir. */
function aistatusTarget(dataDir: string): string {
  return path.join(dataDir, 'home', '.aistatus', 'config.yaml');
}

test('migrateAistatusConfigLocation: moves old config when target does not exist', async () => {
  const idx = _testIdx++;
  const { dataDir } = setupDirs(idx);
  const targetPath = aistatusTarget(dataDir);

  // Create old config file at the wrong location
  const oldPath = path.join(dataDir, 'config', 'config.yaml');
  const content = 'name: testuser\norg: testorg\nemail: test@example.com\nuploadEnabled: true\n';
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, content);

  await migrateAistatusConfigLocation(dataDir, targetPath);

  assert.equal(await fs.readFile(targetPath, 'utf8'), content, 'target should receive the old config');
  const oldExists = await fs.stat(oldPath).catch(() => null);
  assert.equal(oldExists, null, 'old file should be deleted after a successful copy');
});

test('migrateAistatusConfigLocation: deletes malformed old config without copying', async () => {
  const idx = _testIdx++;
  const { dataDir } = setupDirs(idx);

  // Create malformed config: does not open with a `key:` line, which is what the migration
  // accepts as YAML (so a `word: ...` string would count as valid and be copied).
  const oldPath = path.join(dataDir, 'config', 'config.yaml');
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, '{{ not yaml');

  const targetPath = aistatusTarget(dataDir);
  await migrateAistatusConfigLocation(dataDir, targetPath);

  // Old file should be deleted (malformed files are cleaned up)
  const oldExists = await fs.stat(oldPath).catch(() => null);
  assert.equal(oldExists, null, 'malformed old file should be deleted');
  const targetExists = await fs.stat(targetPath).catch(() => null);
  assert.equal(targetExists, null, 'malformed config must not be copied to the target');
});

// ── provider usage billing split (M11) ─────────────────────────

const PROVIDER_STATE_FILE = 'data/provider-state.json';

async function migrateProviderUsage(idx: number, providerUsage: unknown[]): Promise<any[]> {
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  const target = path.join(dataDir, PROVIDER_STATE_FILE);
  await writeJson(target, { rateLimitThrottle: null, resumeQueue: [], providerUsage });
  await runMigrations({ dataDir, storeDir, defaultsDir });
  return ((await readJson(target)) as { providerUsage: any[] }).providerUsage;
}

function legacyRow(provider: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider, displayName: provider, modes: [provider],
    windows: [], observedAt: null, freshness: 'unsupported', ...extra,
  };
}

test('provider usage migration drops rows that never carried an observation', async () => {
  const rows = await migrateProviderUsage(_testIdx++, [
    // The reported ghost: fabricated by the old hardcoded provider table.
    legacyRow('qwen-local', { spend: { today: 0, month: 0 } }),
    // A quota row that never received a reading is equally uninformative.
    legacyRow('openai-codex', { freshness: 'stale' }),
    legacyRow('deepseek', { spend: { today: 0.31, month: 0.31 } }),
  ]);

  assert.deepEqual(rows.map((row) => row.provider), ['deepseek']);
});

test('provider usage migration stamps survivors with their billing kind', async () => {
  const rows = await migrateProviderUsage(_testIdx++, [
    legacyRow('anthropic', {
      freshness: 'stale', observedAt: 1_789_149_559,
      windows: [{ type: 'five_hour', utilization: 0.6, resetsAt: 1_789_165_200 }],
    }),
    legacyRow('deepseek', { spend: { today: 0.31, month: 0.31 } }),
  ]);

  assert.deepEqual(
    rows.map((row) => [row.provider, row.billing]),
    [['anthropic', 'subscription'], ['deepseek', 'api']],
  );
});

test('provider usage migration keeps an existing billing tag and is idempotent', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  const target = path.join(dataDir, PROVIDER_STATE_FILE);
  // A quota-bearing row already tagged 'api' must not be re-classified.
  await writeJson(target, {
    rateLimitThrottle: null, resumeQueue: [],
    providerUsage: [legacyRow('vendor', {
      billing: 'api', observedAt: 10,
      windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: null }],
    })],
  });

  await runMigrations({ dataDir, storeDir, defaultsDir });
  const once = await fs.readFile(target, 'utf8');
  await runMigrations({ dataDir, storeDir, defaultsDir });

  assert.equal(await fs.readFile(target, 'utf8'), once, 'second run must be a no-op');
  assert.equal(((JSON.parse(once) as any).providerUsage[0]).billing, 'api');
});

test('provider usage migration leaves an unrecognised file shape untouched', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  const target = path.join(dataDir, PROVIDER_STATE_FILE);
  await writeJson(target, { rateLimitThrottle: null, resumeQueue: [] });

  await runMigrations({ dataDir, storeDir, defaultsDir });

  assert.deepEqual(await readJson(target), { rateLimitThrottle: null, resumeQueue: [] });
});

// ── Browser session location (registered S2 step) ──────────────

for (const scenario of ['absent', 'present', 'conflict'] as const) {
  test(`UI session migration: ${scenario}, repeated with and without version tracking`, async () => {
    const dirs = setupDirs(_testIdx++);
    const source = path.join(dirs.dataDir, 'ui-sessions.json');
    const destination = path.join(dirs.storeDir, 'ui-sessions.json');
    const versionsFile = path.join(dirs.storeDir, 'versions.json');
    const legacy = JSON.stringify({ 'fixture-browser-session': Date.now() + 60_000 });
    // An existing, empty destination represents sessions that have been revoked.
    if (scenario !== 'absent') {
      await writeText(source, legacy);
      await fs.chmod(source, 0o600);
    }
    if (scenario === 'conflict') await writeText(destination, '{}');
    // Existing migration keys must not suppress this new independent step.
    const existingVersions = { 'data/session-registry.jsonl': '2026.9.15' };
    await writeJson(versionsFile, existingVersions);

    for (let run = 0; run < 3; run++) {
      // Also prove action-level idempotence if the tracking file is lost.
      if (run === 2) await writeJson(versionsFile, existingVersions);
      await runMigrations(dirs);
      const versions = await readJson(versionsFile) as Record<string, string>;
      assert.equal(versions['data/ui-sessions.json'], '2026.9.15');
      if (scenario === 'absent') {
        await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
      } else if (scenario === 'conflict') {
        assert.equal(await readText(destination), '{}');
        assert.equal(await readText(source), legacy);
      } else {
        assert.equal(await readText(destination), legacy);
        assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
        await assert.rejects(fs.stat(source), { code: 'ENOENT' });
      }
    }
  });
}

test('UI session migration: filesystem failure leaves key pending and retries next run', async () => {
  const dirs = setupDirs(_testIdx++);
  const source = path.join(dirs.dataDir, 'ui-sessions.json');
  // A directory cannot be copied as a credential file (portable failure injection).
  await fs.mkdir(source, { recursive: true });
  try {
    await runMigrations(dirs);
    const versions = await readJson(path.join(dirs.storeDir, 'versions.json')) as Record<string, string>;
    assert.equal(versions['data/ui-sessions.json'], undefined);
  } finally {
    await fs.chmod(source, 0o700);
    await fs.rmdir(source);
  }
  await fs.writeFile(source, '{}', { mode: 0o600 });
  await runMigrations(dirs);
  const versions = await readJson(path.join(dirs.storeDir, 'versions.json')) as Record<string, string>;
  assert.equal(versions['data/ui-sessions.json'], '2026.9.15');
  assert.equal(await readText(path.join(dirs.storeDir, 'ui-sessions.json')), '{}');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

// ── Step migrations (generic step-runner contract) ─────────────
// The step framework is exercised via the `stepMigrations` override in MigrationOptions so we can
// drive bump / skip / throw / ordering with probe steps rather than the real S1 import.

const CURRENT_VERSION = '2026.9.14'; // = CORTEX_VERSION; a step at this version is pending from 0.0.0.

test('step migration runs once and bumps versions.json under its key', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  let runs = 0;
  const step: StepMigration = {
    key: 'data/probe.json',
    version: CURRENT_VERSION,
    run: async () => { runs += 1; },
  };

  await runMigrations({ dataDir, storeDir, defaultsDir, stepMigrations: [step] });
  assert.equal(runs, 1, 'step ran once');
  let versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['data/probe.json'], CURRENT_VERSION, 'key bumped to step version');

  // Second run: tracked === version → not pending → step does not run again.
  await runMigrations({ dataDir, storeDir, defaultsDir, stepMigrations: [step] });
  assert.equal(runs, 1, 'step skipped on second run (already tracked)');
});

test('step migration is skipped when tracked >= version', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);
  // Pre-track a version >= the step version.
  await writeJson(path.join(storeDir, 'versions.json'), { 'data/probe.json': CURRENT_VERSION });

  let runs = 0;
  const step: StepMigration = { key: 'data/probe.json', version: CURRENT_VERSION, run: async () => { runs += 1; } };
  await runMigrations({ dataDir, storeDir, defaultsDir, stepMigrations: [step] });
  assert.equal(runs, 0, 'already-tracked step must not run');
});

test('a throwing step does not bump its key and does not block file migrations', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  // A normal file migration that must still apply despite the throwing step.
  await writeJson(path.join(configDir, 'profiles.json'), UNMIGRATED_PROFILES);

  let laterRan = 0;
  const throwing: StepMigration = {
    key: 'data/boom.json', version: CURRENT_VERSION,
    run: async () => { throw new Error('boom'); },
  };
  const later: StepMigration = {
    key: 'data/after-boom.json', version: CURRENT_VERSION, run: async () => { laterRan += 1; },
  };

  await runMigrations({ dataDir, storeDir, defaultsDir, stepMigrations: [throwing, later] });

  // File migration applied (step throw did not abort the run — steps run after the file loop anyway).
  const migrated = await readJson(path.join(configDir, 'profiles.json')) as any;
  assert.equal(migrated.profiles.execute.provider, 'anthropic');

  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['data/boom.json'], undefined, 'throwing step must not bump');
  assert.equal(versions['data/after-boom.json'], CURRENT_VERSION, 'a later step still runs');
  assert.equal(laterRan, 1, 'a throwing step does not block subsequent steps');
});

test('steps run AFTER file migrations (a step sees the file-loop output)', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, configDir, defaultsDir } = setupDirs(idx);

  await writeJson(path.join(configDir, 'profiles.json'), UNMIGRATED_PROFILES);

  let sawProvider: string | undefined;
  const probe: StepMigration = {
    key: 'data/order-probe.json', version: CURRENT_VERSION,
    run: async ({ dataDir: dd }) => {
      const cfg = await readJson(path.join(dd, 'config', 'profiles.json')) as any;
      sawProvider = cfg.profiles.execute.provider;
    },
  };

  await runMigrations({ dataDir, storeDir, defaultsDir, stepMigrations: [probe] });
  assert.equal(sawProvider, 'anthropic', 'step observed the migrated file → ran after the file loop');
});

test('the registered S1 step imports the legacy session stores via runMigrations', async () => {
  const idx = _testIdx++;
  const { dataDir, storeDir, defaultsDir } = setupDirs(idx);

  // Minimal legacy stores in storeDir (= dataDir/data).
  await writeJson(path.join(storeDir, 'sessions.json'), { 'web:c1': 'sess-1' });
  await writeJson(path.join(storeDir, 'conversation-ledger.json'), {
    'web:c1': { sessionId: 'sess-1', sessionName: 'cortex-1', backend: 'pi', profileName: null, turns: [], updatedAt: '2026-09-12T00:00:00.000Z' },
  });

  // Default step list (no override) → real S1 runs.
  await runMigrations({ dataDir, storeDir, defaultsDir });

  const versions = await readJson(path.join(storeDir, 'versions.json')) as any;
  assert.equal(versions['data/session-registry.jsonl'], CURRENT_VERSION, 'S1 bumped its key');
  // Sources renamed aside → import happened through the real registered step.
  await assert.rejects(fs.stat(path.join(storeDir, 'sessions.json')));
  await assert.rejects(fs.stat(path.join(storeDir, 'conversation-ledger.json')));
  assert.ok(await fs.stat(path.join(storeDir, `sessions.json.pre-${CURRENT_VERSION}.bak`)));
});
