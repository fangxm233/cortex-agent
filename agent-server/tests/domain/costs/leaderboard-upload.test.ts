import { afterEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { UsageUploader } from 'aistatus';
import {
  createLeaderboardUpload, flushLeaderboardUploads, leaderboardRecord, leaderboardUpload,
} from '../../../src/domain/costs/leaderboard-upload.js';
import { costRepo, recordCost, type CostEntry } from '../../../src/domain/costs/cost-tracker.js';
import type { UsageSharingSettings } from '../../../src/domain/costs/aistatus-config.js';

function row(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    timestamp: '2026-10-30T12:00:00.000Z', project: 'nimbus', trigger: 'user', cost_usd: 0.42,
    num_turns: null, duration_s: null, backend: 'claude', mode: 'plan', connection: 'subscription',
    source: 'estimate', input_tokens: 12, output_tokens: 340, cache_read_tokens: 5000,
    cache_creation_tokens: 700, provider: 'anthropic', model: 'claude-opus-x[1m]',
    ...overrides,
  };
}

const SHARING_ON: UsageSharingSettings = { enabled: true, name: 'Ada', org: '', email: 'ada@example.com' };

/** The SDK's own uploader, with its queue push stubbed so nothing can reach the network. */
function stubbedUploader() {
  const uploader = new UsageUploader({ uploadEnabled: false, name: null, org: null, email: null });
  const upload = vi.spyOn(uploader, 'upload').mockImplementation(() => {});
  return { uploader, upload };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('leaderboardRecord', () => {
  test('a Claude row uploads its tokens and cost under the bare model name', () => {
    assert.deepEqual(leaderboardRecord(row()), {
      ts: '2026-10-30T12:00:00.000Z', provider: 'anthropic', model: 'claude-opus-x',
      in: 12, out: 340, cache_creation_in: 700, cache_read_in: 5000, cost: 0.42,
    });
  });

  test.each([
    ['openai-codex', 'gpt-x', 'openai'],
    ['google-gemini-cli', 'gemini-x', 'google'],
    ['deepseek', 'deepseek-flash', 'deepseek'],
    ['openrouter', 'anthropic/claude-x', 'anthropic'],
  ])('PI provider %s / %s is reported as %s, as the gateway named it', (provider, model, expected) => {
    const record = leaderboardRecord(row({ backend: 'pi', mode: 'api', connection: provider, provider, model }));
    assert.equal(record?.provider, expected);
    assert.equal(record?.model, model);
  });

  test('missing figures upload as zero, a known duration as latency', () => {
    const record = leaderboardRecord(row({
      cost_usd: null, input_tokens: null, cache_read_tokens: undefined, duration_s: 2.5,
    }));
    assert.equal(record?.cost, 0);
    assert.equal(record?.in, 0);
    assert.equal(record?.cache_read_in, 0);
    assert.equal(record?.latency_ms, 2500);
  });

  test('a row without a provider credits Claude to Anthropic and skips PI', () => {
    assert.equal(leaderboardRecord(row({ provider: undefined, model: undefined }))?.model, 'anthropic/unknown');
    assert.equal(leaderboardRecord(row({ backend: 'pi', provider: undefined })), null);
  });
});

describe('createLeaderboardUpload', () => {
  test('with sharing on, each row is uploaded once with the stored identity', () => {
    const { uploader, upload } = stubbedUploader();
    const setConfig = vi.spyOn(uploader, 'setConfig');
    createLeaderboardUpload({ uploader, readSharing: () => SHARING_ON }).share(row());
    assert.deepEqual(setConfig.mock.calls, [[{ uploadEnabled: true, name: 'Ada', org: null, email: 'ada@example.com' }]]);
    assert.equal(upload.mock.calls.length, 1);
    assert.equal(upload.mock.calls[0][0].model, 'claude-opus-x');
  });

  test.each([
    ['sharing is off', { ...SHARING_ON, enabled: false }],
    ['the email is missing', { ...SHARING_ON, email: '' }],
    ['the name is missing', { ...SHARING_ON, name: '' }],
  ])('nothing is uploaded when %s', (_case, sharing) => {
    const { uploader, upload } = stubbedUploader();
    createLeaderboardUpload({ uploader, readSharing: () => sharing }).share(row());
    assert.equal(upload.mock.calls.length, 0);
  });

  test('turning sharing off takes effect on the next row', () => {
    const { uploader, upload } = stubbedUploader();
    let sharing = SHARING_ON;
    const share = createLeaderboardUpload({ uploader, readSharing: () => sharing });
    share.share(row());
    sharing = { ...SHARING_ON, enabled: false };
    share.share(row());
    assert.equal(upload.mock.calls.length, 1);
  });

  test('an unreadable config or a failing uploader never reaches the caller', () => {
    const { uploader, upload } = stubbedUploader();
    upload.mockImplementation(() => { throw new Error('queue full'); });
    assert.doesNotThrow(() => createLeaderboardUpload({ uploader, readSharing: () => SHARING_ON }).share(row()));
    assert.doesNotThrow(() => createLeaderboardUpload({
      uploader, readSharing: () => { throw new Error('bad yaml'); },
    }).share(row()));
  });
});

test('the daemon uploader sends nothing from a test process', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  leaderboardUpload.share(row());
  await flushLeaderboardUploads(100);
  assert.equal(fetch.mock.calls.length, 0);
});

test('recordCost files the row with its connection, then offers that row for upload', async () => {
  const shared: CostEntry[] = [];
  await recordCost({
    project: 'nimbus', trigger: 'user', cost_usd: 0.2, backend: 'claude', connection: 'my-relay',
    input_tokens: 3, output_tokens: 4, provider: 'anthropic', model: 'claude-x',
  }, { share: (entry) => { shared.push(entry); } });
  const stored = (await costRepo.readCosts()).entries.at(-1);
  assert.equal(stored?.connection, 'my-relay');
  assert.equal(stored?.mode, 'api', 'a key connection bills to the api bucket');
  assert.deepEqual(shared, [stored]);
});
