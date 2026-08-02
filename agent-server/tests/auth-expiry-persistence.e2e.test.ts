// input:  temp saved env, auth status, expiry scan
// output: saved Claude expiry scan end-to-end proof
// pos:    Saved subscription expiry scan regression
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { CONFIG_DIR } from '../src/core/utils.js';
import { getAuthStatus, type AuthStatusSnapshot } from '../src/domain/auth/auth-status.js';
import type { PiRuntimeLoadResult } from '../src/domain/auth/pi-runtime.js';
import { runAuthExpiryScan } from '../src/domain/scheduling/jobs/auth-expiry-scan.js';
import { ctx as jobCtx } from '../src/domain/scheduling/job-registry.js';
import { EventBus } from '../src/events/event-bus.js';
import { buildAuthRequiredLoginAction } from '../src/orchestration/routing/commands/login-notice.js';
import { MockAdapter, type PostedMessage } from '../src/platform/testing.js';

const NOW_MS = Date.parse('2030-01-01T08:30:00.000Z');
const EXPIRES_AT = new Date(NOW_MS + 6 * 24 * 60 * 60 * 1000).toISOString();
const TOKEN = '\uE500\uE501\uE502\uE503';
const TEST_HOME = process.env.CORTEX_HOME!;
const REAL_ENV_FILE = path.join(os.homedir(), '.cortex', 'config', '.env');
const REAL_CLAUDE_CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');

interface FileStamp {
  exists: boolean;
  mtimeMs: number | null;
}

function fileStamp(filePath: string): FileStamp {
  try {
    return { exists: true, mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
    return { exists: false, mtimeMs: null };
  }
}

function liveFileStamps(): Record<string, FileStamp> {
  return {
    [REAL_ENV_FILE]: fileStamp(REAL_ENV_FILE),
    [REAL_CLAUDE_CREDENTIALS]: fileStamp(REAL_CLAUDE_CREDENTIALS),
  };
}

function assertLiveFilesUnchanged(before: Record<string, FileStamp>): void {
  for (const [filePath, stamp] of Object.entries(before)) {
    assert.deepEqual(fileStamp(filePath), stamp, `${filePath} mtime changed`);
  }
}

function unavailablePi(): PiRuntimeLoadResult {
  return {
    available: false, version: null, entry: null, error: 'fixture unavailable',
    runtime: null, readStoredCredential: null,
  };
}

function writeSavedSubscription(): void {
  assert.notEqual(path.resolve(TEST_HOME), path.join(os.homedir(), '.cortex'));
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, '.env'), [
    `CLAUDE_CODE_OAUTH_TOKEN=${JSON.stringify(TOKEN)}`,
    `CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT=${JSON.stringify(EXPIRES_AT)}`,
    '',
  ].join('\n'), { mode: 0o600 });
}

async function readRealSnapshot(): Promise<AuthStatusSnapshot> {
  return getAuthStatus({
    now: () => new Date(NOW_MS),
    claudeCredentialsPath: path.join(TEST_HOME, '.claude', '.credentials.json'),
    piAuthPath: path.join(TEST_HOME, '.pi', 'agent', 'auth.json'),
    loadPiRuntime: async () => unavailablePi(),
    getActiveBackend: () => 'claude',
    listProfiles: () => [],
    getClaudeMode: () => 'plan',
  });
}

async function scanSnapshot(snapshot: AuthStatusSnapshot) {
  const adapter = new MockAdapter({ adminChannel: 'slack:admin' });
  const warnings: Array<{ level: string; text: string }> = [];
  const bus = new EventBus();
  bus.subscribe('system.notice', event => { warnings.push(event); });
  jobCtx.bus = bus;
  await runAuthExpiryScan(adapter, {
    now: () => NOW_MS,
    readStatus: async () => snapshot,
    wasRecentlyNotified: () => false,
    buildPlatformAction: buildAuthRequiredLoginAction,
  });
  return { adapter, warnings };
}

function actionMetadata(post: PostedMessage): Record<string, unknown> {
  const actions = post.content.richBlocks?.find(block => block.type === 'actions');
  assert.ok(actions?.type === 'actions');
  return JSON.parse(actions.elements[0].value) as Record<string, unknown>;
}

function assertTokenFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const fragment of [...TOKEN]) assert.equal(serialized.includes(fragment), false);
}

test('saved Claude subscription expiry reaches the daily warning scan', async () => {
  const liveBefore = liveFileStamps();
  try {
    writeSavedSubscription();
    const snapshot = await readRealSnapshot();
    const claude = snapshot.accounts.find(account => account.backend === 'claude');
    assert.deepEqual(
      { state: claude?.state, inUse: claude?.inUse, expiresAt: claude?.expiresAt },
      { state: 'expiring', inUse: true, expiresAt: EXPIRES_AT },
    );

    const { adapter, warnings } = await scanSnapshot(snapshot);
    assert.equal(adapter.posted.length, 1);
    assert.deepEqual(warnings.map(({ level }) => level), ['warning']);
    const metadata = actionMetadata(adapter.posted[0]);
    assert.deepEqual(
      { backend: metadata.backend, provider: metadata.provider, authType: metadata.authType },
      { backend: 'claude', provider: 'anthropic', authType: 'oauth' },
    );
    assertTokenFree([adapter.posted[0].content, metadata, warnings]);
  } finally {
    jobCtx.bus = null;
    assertLiveFilesUnchanged(liveBefore);
  }
});
