// input:  temporary dotenv file and isolated environment objects
// output: file-only OAuth expiry exclusion regression
// pos:    Runtime dotenv loading policy tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { loadRuntimeDotenv } from '../../src/core/runtime-env.js';

const EXPIRY_KEY = 'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT';

test('runtime dotenv excludes managed expiry while preserving an operator ambient value', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-runtime-env-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, [
    'OTHER_SETTING=from-file',
    `${EXPIRY_KEY}=2030-01-01T00:00:00.000Z`,
    '',
  ].join('\n'));

  const cleanTarget: NodeJS.ProcessEnv = {};
  loadRuntimeDotenv(envFile, cleanTarget);
  assert.deepEqual(cleanTarget, { OTHER_SETTING: 'from-file' });

  const ambientTarget: NodeJS.ProcessEnv = { [EXPIRY_KEY]: 'operator-value' };
  loadRuntimeDotenv(envFile, ambientTarget);
  assert.deepEqual(ambientTarget, {
    OTHER_SETTING: 'from-file',
    [EXPIRY_KEY]: 'operator-value',
  });
});
