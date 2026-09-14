import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { consumeProductionServerAuth } from '../../src/entry/production-app-bootstrap.js';

test('bootstrap consumes and unlinks server auth before app import', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-production-auth-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const authPath = path.join(root, 'auth.json');
  const payload = { clientToken: 'a'.repeat(64), webhookToken: 'b'.repeat(64) };
  fs.writeFileSync(authPath, JSON.stringify(payload), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { CORTEX_PRODUCTION_AUTH_FILE: authPath };

  consumeProductionServerAuth(authPath, env);

  assert.equal(fs.existsSync(authPath), false);
  assert.equal(env.CORTEX_PRODUCTION_AUTH_FILE, undefined);
  assert.equal(env.CORTEX_CLIENT_TOKEN, payload.clientToken);
  assert.equal(env.CORTEX_WEBHOOK_TOKEN, payload.webhookToken);
});
