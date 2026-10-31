import { afterAll, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const home = process.env.CORTEX_HOME!;
const aistatusHome = path.join(home, 'aistatus-home');

beforeAll(() => {
  fs.writeFileSync(path.join(home, 'config/.env'), `CORTEX_AISTATUS_HOME=${aistatusHome}\n`);
  vi.resetModules();
});
afterAll(() => vi.restoreAllMocks());

test('usage-sharing settings live under the home config/.env names', async () => {
  const sharing = await import('../src/domain/costs/aistatus-config.js');
  sharing.writeUsageSharing({ enabled: false });
  assert.equal(sharing.readUsageSharing().enabled, false);
  assert(fs.existsSync(path.join(aistatusHome, '.aistatus/config.yaml')));
});
