// input:  Vitest, codex quota header fixtures
// output: window-extraction, disabled-window and notice-codec assertions
// pos:    Covers Codex quota header parsing and its child-to-server wire form
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseCodexQuotaHeaders,
  encodeQuotaNotice,
  decodeQuotaNotice,
} from '../src/domain/costs/codex-quota.js';

/** Real capture from chatgpt.com/backend-api via the Cortex gateway (2026-08-04, pro plan). */
const LIVE_HEADERS: Record<string, string> = {
  'x-codex-active-limit': 'premium',
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '93',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-after-seconds': '337636',
  'x-codex-primary-reset-at': '1786160107',
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-secondary-reset-after-seconds': '0',
  'x-codex-secondary-reset-at': '',
  'x-codex-credits-balance': '0',
};

test('extracts the weekly window and drops the disabled secondary window', () => {
  const reading = parseCodexQuotaHeaders(LIVE_HEADERS, { nowMs: 1785822470_000 });
  assert.deepEqual(reading, {
    provider: 'openai-codex',
    planType: 'pro',
    windows: [{ type: 'seven_day', utilization: 0.93, resetsAt: 1786160107 }],
  });
});

test('reports the five-hour window when the secondary window comes back', () => {
  const reading = parseCodexQuotaHeaders(
    {
      ...LIVE_HEADERS,
      'x-codex-secondary-used-percent': '40',
      'x-codex-secondary-window-minutes': '300',
      'x-codex-secondary-reset-after-seconds': '600',
      'x-codex-secondary-reset-at': '1785823070',
    },
    { nowMs: 1785822470_000 },
  );
  assert.deepEqual(reading?.windows, [
    { type: 'seven_day', utilization: 0.93, resetsAt: 1786160107 },
    { type: 'five_hour', utilization: 0.4, resetsAt: 1785823070 },
  ]);
});

test('derives resetsAt from reset-after-seconds when the absolute stamp is absent', () => {
  const reading = parseCodexQuotaHeaders(
    { ...LIVE_HEADERS, 'x-codex-primary-reset-at': '' },
    { nowMs: 1785822470_000 },
  );
  assert.deepEqual(reading?.windows, [
    { type: 'seven_day', utilization: 0.93, resetsAt: 1785822470 + 337636 },
  ]);
});

test('labels an unrecognized window length by its duration instead of guessing', () => {
  const reading = parseCodexQuotaHeaders(
    { ...LIVE_HEADERS, 'x-codex-primary-window-minutes': '1440' },
    { nowMs: 1785822470_000 },
  );
  assert.equal(reading?.windows[0]?.type, 'window_1440m');
});

test('reads headers case-insensitively', () => {
  const upper: Record<string, string> = {};
  for (const [k, v] of Object.entries(LIVE_HEADERS)) upper[k.toUpperCase()] = v;
  const reading = parseCodexQuotaHeaders(upper, { nowMs: 1785822470_000 });
  assert.equal(reading?.windows[0]?.utilization, 0.93);
});

test('returns null for responses that carry no codex quota headers', () => {
  const reading = parseCodexQuotaHeaders(
    { 'content-type': 'text/event-stream', 'x-gateway-backend': 'anthropic:passthrough' },
    { nowMs: 1785822470_000 },
  );
  assert.equal(reading, null);
});

test('returns null when every window is disabled so a dead bucket never throttles', () => {
  const reading = parseCodexQuotaHeaders(
    {
      'x-codex-plan-type': 'pro',
      'x-codex-primary-used-percent': '0',
      'x-codex-primary-window-minutes': '0',
      'x-codex-secondary-used-percent': '0',
      'x-codex-secondary-window-minutes': '0',
    },
    { nowMs: 1785822470_000 },
  );
  assert.equal(reading, null);
});

test('carries a reading across the notice codec unchanged', () => {
  const reading = parseCodexQuotaHeaders(LIVE_HEADERS, { nowMs: 1785822470_000 })!;
  assert.deepEqual(decodeQuotaNotice(encodeQuotaNotice(reading)), reading);
});

test('decodes only prefixed notices so ordinary notify text stays inert', () => {
  assert.equal(decodeQuotaNotice('Build finished'), null);
  assert.equal(decodeQuotaNotice(''), null);
  assert.equal(decodeQuotaNotice(undefined), null);
  assert.equal(decodeQuotaNotice(42), null);
});

test('rejects a prefixed notice whose payload is not a usable reading', () => {
  const prefix = encodeQuotaNotice(
    parseCodexQuotaHeaders(LIVE_HEADERS, { nowMs: 1785822470_000 })!,
  ).split('{')[0];
  assert.equal(decodeQuotaNotice(`${prefix}not json`), null);
  assert.equal(decodeQuotaNotice(`${prefix}{"provider":"openai-codex"}`), null);
  assert.equal(decodeQuotaNotice(`${prefix}{"provider":"openai-codex","windows":[]}`), null);
});

test('ignores a malformed used-percent rather than reporting a bogus utilization', () => {
  const reading = parseCodexQuotaHeaders(
    { ...LIVE_HEADERS, 'x-codex-primary-used-percent': 'n/a' },
    { nowMs: 1785822470_000 },
  );
  assert.equal(reading, null);
});
