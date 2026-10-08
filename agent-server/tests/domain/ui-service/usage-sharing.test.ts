import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'vitest';
import { TRPCError } from '@trpc/server';
import { parse as yamlParse } from 'yaml';

import { EventBus } from '../../../src/events/event-bus.js';
import { createAppRouter } from '../../../src/domain/ui-service/app-router.js';
import { createUiService, redactMutationAuditArgs } from '../../../src/domain/ui-service/ui-service.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';

const IDENTITY = { name: 'Ada', org: 'Lab', email: 'ada@example.com' };

function setup() {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'cortex-ui-usage-sharing-')), 'aistatus');
  const events: unknown[] = [];
  const deps = {
    usageSharingDir: dir,
    bus: Object.assign(new EventBus(), { publish: (event: unknown) => events.push(event) }),
  } as unknown as UiServiceDeps;
  const caller = createAppRouter(createUiService(deps)).createCaller({});
  return { dir, events, caller };
}

async function rejection(promise: Promise<unknown>): Promise<TRPCError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TRPCError);
    return err;
  }
  throw new Error('expected the call to be rejected');
}

test('usageSharing.get reports opted out when no config exists', async () => {
  const { caller } = setup();
  assert.deepEqual(await caller.usageSharing.get({}), { enabled: false, name: '', org: '', email: '' });
});

test('usageSharing.set stores a trimmed identity and returns the saved state', async () => {
  const { dir, caller } = setup();

  const saved = await caller.usageSharing.set({
    enabled: true, name: '  Ada ', org: ' Lab', email: 'ada@example.com ',
  });

  assert.deepEqual(saved, { enabled: true, ...IDENTITY });
  assert.deepEqual(await caller.usageSharing.get({}), saved);
  assert.equal(yamlParse(readFileSync(path.join(dir, 'config.yaml'), 'utf-8')).uploadEnabled, true);
});

test('usageSharing.set accepts an empty organization', async () => {
  const { caller } = setup();
  const saved = await caller.usageSharing.set({ enabled: true, name: 'Ada', email: 'ada@example.com' });
  assert.equal(saved.org, '');
});

test('usageSharing.set rejects enabling without a name or a valid email and writes nothing', async () => {
  const { dir, caller } = setup();

  const missingName = await rejection(caller.usageSharing.set({ enabled: true, name: ' ', email: 'ada@example.com' }));
  const badEmail = await rejection(caller.usageSharing.set({ enabled: true, name: 'Ada', email: 'ada' }));

  assert.equal(missingName.code, 'BAD_REQUEST');
  assert.equal(badEmail.code, 'BAD_REQUEST');
  assert.equal(existsSync(path.join(dir, 'config.yaml')), false);
});

test('usageSharing.set rejects a malformed request', async () => {
  const { caller } = setup();
  const err = await rejection(caller.usageSharing.set({ enabled: 'yes' } as never));
  assert.equal(err.code, 'BAD_REQUEST');
});

test('turning sharing off keeps the stored identity', async () => {
  const { caller } = setup();
  await caller.usageSharing.set({ enabled: true, ...IDENTITY });

  const saved = await caller.usageSharing.set({ enabled: false });

  assert.deepEqual(saved, { enabled: false, ...IDENTITY });
});

test('the audit event records the choice but not the identity', async () => {
  const { events, caller } = setup();
  await caller.usageSharing.set({ enabled: true, ...IDENTITY });

  assert.deepEqual(redactMutationAuditArgs('usageSharing.set', { enabled: true, ...IDENTITY }), { enabled: true });
  assert.ok(!JSON.stringify(events).includes(IDENTITY.email));
});
