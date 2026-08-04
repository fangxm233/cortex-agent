// input:  handleCancelResume + the live resume-registry singleton
// output: cancel outcome for a queued direct resume, idempotence, and the arg guard
// pos:    Covers the web opt-out from an auto-resume promised after a rate limit
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCancelResume } from '../../../src/domain/ui-service/mutate/sessions.js';
import {
  initResumeRegistry, recordResume, getResumeCount, _testReset,
} from '../../../src/domain/costs/resume-registry.js';

async function seedDirectResume(channel: string): Promise<void> {
  await initResumeRegistry({ save: async () => {}, load: async () => [] });
  recordResume({ kind: 'direct', channel, userMessage: 'interrupted turn', recordedAt: Date.now() });
}

test('cancelResume drops the queued direct resume for that session', async (t) => {
  t.onTestFinished(() => _testReset());
  await seedDirectResume('web:s1');

  const res = await handleCancelResume({ sessionId: 's1' });

  assert.deepEqual(res, { ok: true, data: { cancelled: true } });
  assert.equal(getResumeCount(), 0);
});

test('cancelResume after the window already reset succeeds without cancelling anything', async (t) => {
  t.onTestFinished(() => _testReset());
  await seedDirectResume('web:s1');

  // The resume already fired for this session — a late click must not read as an error.
  const res = await handleCancelResume({ sessionId: 's-already-resumed' });

  assert.deepEqual(res, { ok: true, data: { cancelled: false } });
  assert.equal(getResumeCount(), 1, 'another session\'s pending resume is untouched');
});

test('cancelResume without a sessionId → invalid-args', async () => {
  const res = await handleCancelResume({ sessionId: '' });

  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'invalid-args');
});
