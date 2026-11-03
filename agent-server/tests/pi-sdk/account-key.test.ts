// A PI account's sessions sign their requests with the account's own key, not the key Cortex's
// connection installs for the same provider; the default login keeps the connection's.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('./account-key-runner.ts', import.meta.url));

// Do not inherit API keys, proxy settings, package sources, hooks, or live homes.
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CORTEX_HOME: join(home, 'cortex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    PI_OFFLINE: '1',
    NODE_TEST_CONTEXT: '1',
    NO_COLOR: '1',
  };
}

test('a PI account sends its own key; the default login the connection\'s', { timeout: 75_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-account-key-'));
  try {
    await mkdir(join(home, 'cortex', 'config'), { recursive: true });
    const { stdout } = await run(process.execPath, ['--import', 'tsx', runner], {
      cwd: serverDir, env: isolatedEnv(home), timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    expect(stdout).toMatch(/PI_ACCOUNT_KEY_OK default=connection account=own/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
