import { beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../../src/core/paths.js';
import { getSettings, onSettingsChange } from '../../src/core/settings.js';

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), 'condition did not become true before timeout');
}

beforeAll(async () => {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  delete process.env.SLACK_ADMIN_CHANNEL;
  process.env.CORTEX_ADMIN_CHANNEL = 'cortex-fallback';
  await fs.writeFile(SETTINGS_FILE, '{');
});

test('malformed first read uses env/defaults and later accepts a valid file', async (t) => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const initial = getSettings();
  assert.equal(initial.turnNotify, true);
  assert.equal(initial.adminChannel, 'cortex-fallback');
  assert.match(errors.mock.calls.map((args) => args.join(' ')).join('\n'), /Load settings\.json failed/);

  const batches: string[][] = [];
  const unsubscribe = onSettingsChange((keys) => batches.push([...keys]));
  t.onTestFinished(unsubscribe);
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({ turnNotify: false }));

  await waitFor(() => getSettings().turnNotify === false);
  assert.deepEqual(batches, [['turnNotify']]);
});
