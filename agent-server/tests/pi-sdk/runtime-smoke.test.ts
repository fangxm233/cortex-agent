// input:  vitest, node child_process, smoke-runner.ts
// output: credential-free real Pi SDK regression smoke
// pos:    Run the SDK smoke in a private credential-free process
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('./smoke-runner.ts', import.meta.url));

// Do not inherit API keys, proxy settings, package sources, hooks, or live homes.
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CORTEX_HOME: join(home, 'cortex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    PI_CODING_AGENT_DIR: join(home, 'agent'),
    PI_OFFLINE: '1',
    NODE_TEST_CONTEXT: '1',
    NO_COLOR: '1',
  };
}

test('real SDK preserves Cortex tools, system, history and quota across turns/resume', {
  timeout: 75_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-sdk-smoke-'));
  try {
    await mkdir(join(home, 'cortex', 'config'), { recursive: true });
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', runner], {
      cwd: serverDir, env: isolatedEnv(home), timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    expect(stderr).toBe('');
    expect(stdout).toMatch(/PI_SDK_SMOKE_OK version=\S+ requests=6 tools=6 quota=6/);
    console.log(stdout.trim());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
