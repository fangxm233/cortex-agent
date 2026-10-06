import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { configureScheduledJobs } from '../../../src/domain/scheduling/runner.js';
import { ctx, requireJobCtx } from '../../../src/domain/scheduling/job-registry.js';

afterEach(() => {
  Object.assign(ctx, { adapter: null, bus: null, notify: null, deliverScheduledTurn: null });
});

test('configureScheduledJobs injects the whole job context at once', () => {
  const adapter = {} as never;
  const bus = {} as never;
  const notify = async () => {};
  const deliverScheduledTurn = async () => {};
  configureScheduledJobs({ adapter, bus, notify, deliverScheduledTurn });
  assert.equal(ctx.adapter, adapter);
  assert.equal(ctx.bus, bus);
  assert.equal(requireJobCtx('notify'), notify);
  assert.equal(requireJobCtx('deliverScheduledTurn'), deliverScheduledTurn);
});
