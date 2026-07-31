// input:  settings file, hot-reload wiring, composite mocks
// output: external admin-channel reload and clear regression
// pos:    Verifies composition-root admin settings propagation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../../src/core/paths.js';
import { getSettings, updateSettings } from '../../src/core/settings.js';
import { createHotReloadingAdapter } from '../../src/entry/admin-channel-hot-reload.js';
import { CompositeAdapter } from '../../src/platform/adapters/composite-adapter.js';
import { MockAdapter } from '../../src/platform/testing.js';

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

async function waitForAdminChannels(slack: string | null, feishu: string | null): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const settings = getSettings();
    if (settings.adminChannel === slack && settings.feishuAdminChannel === feishu) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('admin channels did not hot-reload before timeout');
}

async function writeAdminChannels(base: object, slack: string | null, feishu: string | null): Promise<void> {
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify({
    ...base,
    adminChannel: slack,
    feishuAdminChannel: feishu,
  })}\n`);
  await waitForAdminChannels(slack, feishu);
}

async function postNoticeConduits(adapters: MockAdapter[]): Promise<string[]> {
  const destination = { type: 'system-notice' as const };
  const refs = await Promise.all(adapters.map((adapter) => (
    adapter.postMessage(destination, { text: 'notice' })
  )));
  return refs.map((ref) => ref.conduit);
}

test('runtime adapter creation registers external admin hot reload and clear propagation', async () => {
  await updateSettings({ adminChannel: 'C-slack-old', feishuAdminChannel: 'oc-old' });
  const slack = new MockAdapter({ adminChannel: 'C-slack-old' });
  const mock = new MockAdapter({ adminChannel: 'C-test-old' });
  const feishu = new MockAdapter({ adminChannel: 'oc-old' });
  Object.defineProperty(slack, 'name', { value: 'slack' });
  Object.defineProperty(feishu, 'name', { value: 'feishu' });
  const composite = new CompositeAdapter([slack, mock, feishu]);
  assert.strictEqual(createHotReloadingAdapter(() => composite), composite);
  const base = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));

  await writeAdminChannels(base, 'C-slack-new', 'oc-old');
  assert.deepEqual(await postNoticeConduits([slack, mock, feishu]), ['C-slack-new', 'C-slack-new', 'oc-old']);
  await writeAdminChannels(base, 'C-slack-new', 'oc-new');
  assert.deepEqual(await postNoticeConduits([slack, mock, feishu]), ['C-slack-new', 'C-slack-new', 'oc-new']);

  const postCounts = [slack.posted.length, mock.posted.length, feishu.posted.length];
  await writeAdminChannels(base, null, null);
  assert.deepEqual(await postNoticeConduits([slack, mock, feishu]), ['', '', '']);
  assert.deepEqual([slack.posted.length, mock.posted.length, feishu.posted.length], postCounts);
});
