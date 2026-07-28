// input:  startup notification helpers and MockAdapter
// output: startup notification behavior tests
// pos:    Verifies configured and disabled startup notifications
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sendStartupDmIfConfigured, buildStartupMessage } from '../src/entry/startup-notify.js';
import { MockAdapter } from '../src/platform/testing.js';

test('sendStartupDmIfConfigured posts one startup message to the admin channel', async () => {
  const adapter = new MockAdapter({ adminChannel: 'D0AH43A75EZ' });

  const sent = await sendStartupDmIfConfigured(adapter, {
    machine: 'local',
  });

  assert.equal(sent, true);
  assert.equal(adapter.posted.length, 1);
  assert.equal(adapter.posted[0].destination.type, 'system-notice');
  assert.equal(adapter.posted[0].content.text, buildStartupMessage({ machine: 'local' }));
});

test('sendStartupDmIfConfigured returns false when no admin channel configured', async () => {
  const adapter = new MockAdapter();

  const sent = await sendStartupDmIfConfigured(adapter, {
    machine: 'local',
  });

  assert.equal(sent, false);
  assert.equal(adapter.posted.length, 0);
});

test('sendStartupDmIfConfigured includes restart reason when provided', async () => {
  const adapter = new MockAdapter({ adminChannel: 'D0AH43A75EZ' });

  await sendStartupDmIfConfigured(adapter, {
    machine: 'local',
    restartReason: 'code change: src/app.ts',
  });

  assert.equal(adapter.posted.length, 1);
  assert.equal(
    adapter.posted[0].content.text,
    buildStartupMessage({ machine: 'local', restartReason: 'code change: src/app.ts' }),
  );
});
