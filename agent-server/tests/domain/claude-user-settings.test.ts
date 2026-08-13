// input:  Claude settings sync helper, temp config dirs, injectable fs hooks, and symlink fixtures
// output: path resolution, merge, no-op, atomic temp-write guards, mode, symlink, corruption, and guard tests
// pos:    Regression tests for Claude user settings cleanup-period syncing
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { syncClaudeUserCleanupPeriodDays } from '../../src/domain/auth/claude-user-settings.js';

async function makeTempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'claude-user-settings-'));
}

function realFs(overrides: Record<string, unknown> = {}) {
  return {
    mkdir: fsp.mkdir.bind(fsp),
    readFile: fsp.readFile.bind(fsp),
    writeFile: fsp.writeFile.bind(fsp),
    stat: fsp.stat.bind(fsp),
    lstat: fsp.lstat.bind(fsp),
    chmod: fsp.chmod.bind(fsp),
    rename: fsp.rename.bind(fsp),
    rm: fsp.rm.bind(fsp),
    readdir: fsp.readdir.bind(fsp),
    realpath: fsp.realpath.bind(fsp),
    open: fsp.open.bind(fsp),
    unlink: fsp.unlink.bind(fsp),
    ...overrides,
  } as any;
}

test('syncClaudeUserCleanupPeriodDays prefers explicit dir, then env, then ~/.claude', async () => {
  const root = await makeTempRoot();
  const explicitHome = path.join(root, 'explicit-home');
  const envHome = path.join(root, 'env-home');
  const fallbackHome = path.join(root, 'fallback-home');

  const explicit = await syncClaudeUserCleanupPeriodDays(14, {
    claudeConfigDir: '~/custom-claude',
    homedir: () => explicitHome,
  });
  const viaEnv = await syncClaudeUserCleanupPeriodDays(21, {
    env: { CLAUDE_CONFIG_DIR: '~/env-claude' },
    homedir: () => envHome,
  });
  const fallback = await syncClaudeUserCleanupPeriodDays(30, {
    env: {},
    homedir: () => fallbackHome,
  });

  assert.equal(explicit.filePath, path.join(explicitHome, 'custom-claude', 'settings.json'));
  assert.equal(viaEnv.filePath, path.join(envHome, 'env-claude', 'settings.json'));
  assert.equal(fallback.filePath, path.join(fallbackHome, '.claude', 'settings.json'));
});

test('syncClaudeUserCleanupPeriodDays creates the missing dir/file with cleanupPeriodDays only', async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');

  const result = await syncClaudeUserCleanupPeriodDays(45, { claudeConfigDir: configDir });

  assert.equal(result.changed, true);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(result.filePath, 'utf8')),
    { cleanupPeriodDays: 45 },
  );
  assert.equal((await fsp.stat(configDir)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(result.filePath)).mode & 0o777, 0o600);
});

test('syncClaudeUserCleanupPeriodDays merges only cleanupPeriodDays and preserves unknown keys', async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');
  const filePath = path.join(configDir, 'settings.json');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify({ theme: 'dark', nested: { keep: true } }) + '\n');

  await syncClaudeUserCleanupPeriodDays(9, { claudeConfigDir: configDir });

  assert.deepEqual(
    JSON.parse(await fsp.readFile(filePath, 'utf8')),
    { theme: 'dark', nested: { keep: true }, cleanupPeriodDays: 9 },
  );
});

test('syncClaudeUserCleanupPeriodDays is a no-op when cleanupPeriodDays already matches', async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');
  const filePath = path.join(configDir, 'settings.json');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify({ cleanupPeriodDays: 12, keep: 'same' }) + '\n', { mode: 0o600 });
  const before = await fsp.stat(filePath);
  const text = await fsp.readFile(filePath, 'utf8');

  const result = await syncClaudeUserCleanupPeriodDays(12, { claudeConfigDir: configDir });

  const after = await fsp.stat(filePath);
  assert.equal(result.changed, false);
  assert.equal(await fsp.readFile(filePath, 'utf8'), text);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('syncClaudeUserCleanupPeriodDays preserves the existing referent mode', async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');
  const filePath = path.join(configDir, 'settings.json');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify({ cleanupPeriodDays: 3 }) + '\n', { mode: 0o640 });
  await fsp.chmod(filePath, 0o640);

  await syncClaudeUserCleanupPeriodDays(4, { claudeConfigDir: configDir });

  assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o640);
});

test('syncClaudeUserCleanupPeriodDays updates a symlink referent instead of replacing the link', { skip: process.platform === 'win32' }, async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');
  const referentDir = path.join(root, 'real');
  const referentPath = path.join(referentDir, 'settings-target.json');
  const linkPath = path.join(configDir, 'settings.json');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.mkdir(referentDir, { recursive: true });
  await fsp.writeFile(referentPath, JSON.stringify({ keep: true }) + '\n', { mode: 0o600 });
  fs.symlinkSync(referentPath, linkPath);
  const beforeLink = await fsp.readlink(linkPath);

  await syncClaudeUserCleanupPeriodDays(18, { claudeConfigDir: configDir });

  assert.equal((await fsp.lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await fsp.readlink(linkPath), beforeLink);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(referentPath, 'utf8')),
    { keep: true, cleanupPeriodDays: 18 },
  );
});

test('syncClaudeUserCleanupPeriodDays fails closed on malformed or non-object JSON', async () => {
  const root = await makeTempRoot();
  const badDir = path.join(root, 'bad');
  const arrayDir = path.join(root, 'array');
  const badPath = path.join(badDir, 'settings.json');
  const arrayPath = path.join(arrayDir, 'settings.json');
  const badBytes = Buffer.from([0xff, 0xfe, 0x7b, 0x0a]);
  await fsp.mkdir(badDir, { recursive: true });
  await fsp.mkdir(arrayDir, { recursive: true });
  await fsp.writeFile(badPath, badBytes);
  await fsp.writeFile(arrayPath, '[]\n');

  await assert.rejects(() => syncClaudeUserCleanupPeriodDays(7, { claudeConfigDir: badDir }), /settings\.json/i);
  await assert.rejects(() => syncClaudeUserCleanupPeriodDays(7, { claudeConfigDir: arrayDir }), /JSON object/i);
  assert.deepEqual(await fsp.readFile(badPath), badBytes);
  assert.equal(await fsp.readFile(arrayPath, 'utf8'), '[]\n');
});

test('syncClaudeUserCleanupPeriodDays leaves the original file unchanged and cleans temps on temp-write failure', async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');
  const filePath = path.join(configDir, 'settings.json');
  const original = JSON.stringify({ keep: true }) + '\n';
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(filePath, original, { mode: 0o640 });

  await assert.rejects(
    () => syncClaudeUserCleanupPeriodDays(8, {
      claudeConfigDir: configDir,
      fs: realFs({
        writeFile: async (target: string, data: string | Buffer, options?: Record<string, unknown>) => {
          await fsp.writeFile(target, data, options as any);
          throw new Error('forced temp write failure');
        },
      }),
    }),
    /forced temp write failure/,
  );

  assert.equal(await fsp.readFile(filePath, 'utf8'), original);
  assert.deepEqual(await fsp.readdir(configDir), ['settings.json']);
});

test('syncClaudeUserCleanupPeriodDays retries after an external change before rename and merges the newer file', async () => {
  const root = await makeTempRoot();
  const configDir = path.join(root, 'claude');
  const filePath = path.join(configDir, 'settings.json');
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify({ keep: true }) + '\n', { mode: 0o640 });

  let injected = false;
  await syncClaudeUserCleanupPeriodDays(18, {
    claudeConfigDir: configDir,
    fs: realFs({
      writeFile: async (target: string, data: string | Buffer, options?: Record<string, unknown>) => {
        await fsp.writeFile(target, data, options as any);
        if (!injected && target !== filePath) {
          injected = true;
          await fsp.writeFile(filePath, JSON.stringify({ keep: true, external: 'race' }) + '\n', { mode: 0o640 });
        }
      },
    }),
  });

  assert.deepEqual(
    JSON.parse(await fsp.readFile(filePath, 'utf8')),
    { keep: true, external: 'race', cleanupPeriodDays: 18 },
  );
});

test('syncClaudeUserCleanupPeriodDays blocks writes to the real ~/.claude during tests', async () => {
  const realDir = path.join(os.homedir(), '.claude');
  await assert.rejects(
    () => syncClaudeUserCleanupPeriodDays(5, { claudeConfigDir: realDir }),
    /real ~\/\.claude/i,
  );
});

test('syncClaudeUserCleanupPeriodDays blocks writes to descendants of the real ~/.claude during tests', async () => {
  const realDir = path.join(os.homedir(), '.claude', 'nested');
  await assert.rejects(
    () => syncClaudeUserCleanupPeriodDays(5, { claudeConfigDir: realDir }),
    /real ~\/\.claude/i,
  );
});
