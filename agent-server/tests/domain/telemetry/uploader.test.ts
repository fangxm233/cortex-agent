import assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'vitest';
import { chunkEvents, postBatch, UploadBackoff } from '@domain/telemetry/uploader.js';
import { buildEnvelope } from '@domain/telemetry/envelope.js';
import { TELEMETRY_MAX_BATCH_BYTES, TelemetryBatchSchema } from '@domain/telemetry/schema.js';
import { crashEvent, fakeFetch, TEST_ENDPOINT } from './helpers.js';

test('batches respect the event-count and body-size caps', () => {
  const small = Array.from({ length: 450 }, () => crashEvent());
  assert.deepEqual(chunkEvents(small).map((batch) => batch.length), [200, 200, 50]);
  const big = Array.from({ length: 30 }, () => crashEvent({ stack: 'x'.repeat(7_900) }));
  for (const batch of chunkEvents(big)) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) < TELEMETRY_MAX_BATCH_BYTES - 1_000);
  }
});

test('the envelope validates and carries no host details', () => {
  const envelope = buildEnvelope('dev');
  const parsed = TelemetryBatchSchema.safeParse({ envelope, events: [crashEvent()] });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  const text = JSON.stringify(envelope);
  assert.ok(!text.includes(os.hostname()));
  assert.ok(!text.includes(os.userInfo().username));
});

test('postBatch maps HTTP outcomes and never throws', async () => {
  const envelope = buildEnvelope('release');
  const ok = fakeFetch([204, 400, 503, 429, 413]);
  assert.equal(await postBatch(TEST_ENDPOINT, envelope, [crashEvent()], ok.impl), 'sent');
  assert.equal(await postBatch(TEST_ENDPOINT, envelope, [crashEvent()], ok.impl), 'rejected');
  assert.equal(await postBatch(TEST_ENDPOINT, envelope, [crashEvent()], ok.impl), 'retry');
  assert.equal(await postBatch(TEST_ENDPOINT, envelope, [crashEvent()], ok.impl), 'rejected', '429: cap hit, never resent');
  assert.equal(await postBatch(TEST_ENDPOINT, envelope, [crashEvent()], ok.impl), 'rejected');
  const failing = async () => { throw new Error('offline'); };
  assert.equal(await postBatch(TEST_ENDPOINT, envelope, [crashEvent()], failing), 'retry');
  assert.equal(ok.requests[0].url, TEST_ENDPOINT);
  assert.ok(TelemetryBatchSchema.safeParse(ok.requests[0].body).success);
});

test('backoff doubles from one minute and resets on success', () => {
  let now = 0;
  const backoff = new UploadBackoff(() => now);
  backoff.failed();
  now = 59_000;
  assert.equal(backoff.ready(), false);
  now = 60_000;
  assert.equal(backoff.ready(), true);
  backoff.failed();
  now = 60_000 + 119_000;
  assert.equal(backoff.ready(), false);
  backoff.succeeded();
  assert.equal(backoff.ready(), true);
});
