// input:  Node test runner + agent-adapter/claude/cost-from-usage module
// output: usageToCost spec lock-down for DR-0012 TUI mode cost reconstruction
// pos:    Claude TUI adapter pricing math regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { usageToCost, PRICING_TABLE, normalizeModelId, type ClaudeUsage } from '../../src/agent-adapter/claude/cost-from-usage.js';

// --- normalizeModelId ---

test('normalizeModelId maps full API model id to family alias', () => {
  assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'sonnet-4');
  assert.equal(normalizeModelId('claude-sonnet-4-20250514'), 'sonnet-4');
  assert.equal(normalizeModelId('claude-opus-4-1-20250805'), 'opus-4');
  assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'haiku-4');
});

test('normalizeModelId returns null for unrecognized model strings', () => {
  assert.equal(normalizeModelId('gpt-4o'), null);
  assert.equal(normalizeModelId(''), null);
  assert.equal(normalizeModelId(null as any), null);
  assert.equal(normalizeModelId(undefined as any), null);
});

// --- PRICING_TABLE shape ---

test('PRICING_TABLE has entries for sonnet-4 / opus-4 / haiku-4 with required fields', () => {
  for (const key of ['sonnet-4', 'opus-4', 'haiku-4']) {
    const p = PRICING_TABLE[key];
    assert.ok(p, `missing pricing for ${key}`);
    assert.equal(typeof p.inputPerMTok, 'number');
    assert.equal(typeof p.outputPerMTok, 'number');
    assert.equal(typeof p.cacheCreation5mPerMTok, 'number');
    assert.equal(typeof p.cacheCreation1hPerMTok, 'number');
    assert.equal(typeof p.cacheReadPerMTok, 'number');
    // Sanity: output > input, cache_read < input, cache_creation_1h > cache_creation_5m
    assert.ok(p.outputPerMTok > p.inputPerMTok, `${key}: output should cost more than input`);
    assert.ok(p.cacheReadPerMTok < p.inputPerMTok, `${key}: cache_read should be cheaper than input`);
    assert.ok(p.cacheCreation1hPerMTok >= p.cacheCreation5mPerMTok, `${key}: 1h cache write >= 5m`);
  }
});

// --- usageToCost: happy path ---

test('usageToCost: sonnet-4 — known sample from spike matches hand-computed value', () => {
  // From DR-0012 §6 spike sample: 8 output, 78 cache_creation_1h, 20212 cache_read, 6 input
  // Sonnet pricing: $3/M input, $15/M output, $6/M cache_1h, $0.30/M cache_read
  const usage: ClaudeUsage = {
    input_tokens: 6,
    output_tokens: 8,
    cache_creation_input_tokens: 78,
    cache_read_input_tokens: 20212,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 78,
    },
  };
  const result = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  assert.ok(result !== null);
  assert.equal(result!.modelFamily, 'sonnet-4');

  const expected =
    6 * (3.0 / 1_000_000)
    + 8 * (15.0 / 1_000_000)
    + 0 * (3.75 / 1_000_000)
    + 78 * (6.0 / 1_000_000)
    + 20212 * (0.30 / 1_000_000);
  // Allow tiny float tolerance
  assert.ok(Math.abs(result!.totalUsd - expected) < 1e-9, `expected ${expected}, got ${result!.totalUsd}`);
  assert.equal(result!.breakdown.input, 6 * (3.0 / 1_000_000));
  assert.equal(result!.breakdown.output, 8 * (15.0 / 1_000_000));
});

test('usageToCost: handles missing cache_creation sub-object (older usage shape)', () => {
  const usage: ClaudeUsage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const r = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  assert.ok(r !== null);
  const expected = 100 * 3e-6 + 50 * 15e-6;
  assert.ok(Math.abs(r!.totalUsd - expected) < 1e-12);
});

test('usageToCost: handles missing cache_creation_input_tokens entirely (zero defaults)', () => {
  const usage: ClaudeUsage = {
    input_tokens: 10,
    output_tokens: 20,
  };
  const r = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  assert.ok(r !== null);
  const expected = 10 * 3e-6 + 20 * 15e-6;
  assert.ok(Math.abs(r!.totalUsd - expected) < 1e-12);
});

test('usageToCost: when cache_creation has only 5m, applies 5m rate', () => {
  const usage: ClaudeUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
  };
  const r = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  assert.ok(r !== null);
  // sonnet 5m cache create = $3.75/M
  const expected = 1000 * 3.75e-6;
  assert.ok(Math.abs(r!.totalUsd - expected) < 1e-12);
});

test('usageToCost: when cache_creation sub-object missing but cache_creation_input_tokens > 0, falls back to 5m rate', () => {
  // Older Claude versions reported only cache_creation_input_tokens without ephemeral split — treat as 5m
  const usage: ClaudeUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 0,
  };
  const r = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  assert.ok(r !== null);
  const expected = 500 * 3.75e-6;
  assert.ok(Math.abs(r!.totalUsd - expected) < 1e-12);
});

// --- usageToCost: unknown model ---

test('usageToCost: returns null for unrecognized model id (no silent zero)', () => {
  const usage: ClaudeUsage = { input_tokens: 100, output_tokens: 50 };
  assert.equal(usageToCost(usage, 'gpt-4o'), null);
  assert.equal(usageToCost(usage, ''), null);
  assert.equal(usageToCost(usage, null), null);
  assert.equal(usageToCost(usage, undefined), null);
});

// --- usageToCost: opus / haiku ---

test('usageToCost: opus-4 uses higher rates than sonnet', () => {
  const usage: ClaudeUsage = { input_tokens: 1_000_000, output_tokens: 0 };
  const sonnet = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  const opus = usageToCost(usage, 'claude-opus-4-1-20250805');
  assert.ok(sonnet && opus);
  assert.ok(opus!.totalUsd > sonnet!.totalUsd, 'opus should cost more than sonnet for same input');
});

test('usageToCost: haiku-4 is cheaper than sonnet', () => {
  const usage: ClaudeUsage = { input_tokens: 1_000_000, output_tokens: 0 };
  const sonnet = usageToCost(usage, 'claude-sonnet-4-5-20250929');
  const haiku = usageToCost(usage, 'claude-haiku-4-5-20251001');
  assert.ok(sonnet && haiku);
  assert.ok(haiku!.totalUsd < sonnet!.totalUsd, 'haiku should be cheaper than sonnet for same input');
});

// --- usageToCost: zero usage edge case ---

test('usageToCost: all-zero usage returns zero cost, not null', () => {
  const r = usageToCost({ input_tokens: 0, output_tokens: 0 }, 'claude-sonnet-4-5-20250929');
  assert.ok(r !== null);
  assert.equal(r!.totalUsd, 0);
});
