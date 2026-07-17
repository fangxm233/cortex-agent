// input:  Node test runner + core/auth.ts
// output: token timing-safe compare + ensureAuthTokens generation/idempotency tests
// pos:    Regression guard for WS/webhook shared-secret auth (no-Cloudflare auth model)
// >>> If I am updated, update me and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  timingSafeEqualStr,
  ensureAuthTokens,
  AUTH_HEADER,
} from '../../src/core/auth.js';

test('AUTH_HEADER is the lowercase x-cortex-token header name', () => {
  assert.equal(AUTH_HEADER, 'x-cortex-token');
});

test('timingSafeEqualStr returns true only for equal non-empty strings', () => {
  assert.equal(timingSafeEqualStr('abc123', 'abc123'), true);
  assert.equal(timingSafeEqualStr('abc123', 'abc124'), false);
  // length mismatch
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  // empty configured token must never match (fail-closed)
  assert.equal(timingSafeEqualStr('', ''), false);
  assert.equal(timingSafeEqualStr('', 'x'), false);
  assert.equal(timingSafeEqualStr('x', ''), false);
  // undefined inputs
  assert.equal(timingSafeEqualStr(undefined, undefined), false);
  assert.equal(timingSafeEqualStr('x', undefined), false);
  assert.equal(timingSafeEqualStr(undefined, 'x'), false);
});

function tmpEnvPath(t: any): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-'));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.env');
}

test('ensureAuthTokens generates both tokens, sets env, and writes the .env file', (t) => {
  const envPath = tmpEnvPath(t);
  const env: Record<string, string | undefined> = {};
  const result = ensureAuthTokens({ envPath, env });

  // 32 random bytes -> 64 hex chars
  assert.match(result.clientToken, /^[0-9a-f]{64}$/);
  assert.match(result.webhookToken, /^[0-9a-f]{64}$/);
  assert.notEqual(result.clientToken, result.webhookToken);
  assert.deepEqual(result.generated.sort(), ['CORTEX_CLIENT_TOKEN', 'CORTEX_WEBHOOK_TOKEN']);

  // env mutated in place
  assert.equal(env.CORTEX_CLIENT_TOKEN, result.clientToken);
  assert.equal(env.CORTEX_WEBHOOK_TOKEN, result.webhookToken);

  // persisted to the .env file
  assert.ok(existsSync(envPath));
  const written = readFileSync(envPath, 'utf-8');
  assert.match(written, new RegExp(`CORTEX_CLIENT_TOKEN=${result.clientToken}`));
  assert.match(written, new RegExp(`CORTEX_WEBHOOK_TOKEN=${result.webhookToken}`));
});

test('ensureAuthTokens is idempotent — keeps existing tokens and does not rewrite the file', (t) => {
  const envPath = tmpEnvPath(t);
  const env: Record<string, string | undefined> = {
    CORTEX_CLIENT_TOKEN: 'preset-client',
    CORTEX_WEBHOOK_TOKEN: 'preset-webhook',
  };
  const result = ensureAuthTokens({ envPath, env });
  assert.equal(result.clientToken, 'preset-client');
  assert.equal(result.webhookToken, 'preset-webhook');
  assert.deepEqual(result.generated, []);
  // No file written when nothing was generated.
  assert.equal(existsSync(envPath), false);
});

test('ensureAuthTokens only generates the missing token', (t) => {
  const envPath = tmpEnvPath(t);
  const env: Record<string, string | undefined> = { CORTEX_CLIENT_TOKEN: 'preset-client' };
  const result = ensureAuthTokens({ envPath, env });
  assert.equal(result.clientToken, 'preset-client');
  assert.match(result.webhookToken, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.generated, ['CORTEX_WEBHOOK_TOKEN']);
  const written = readFileSync(envPath, 'utf-8');
  assert.doesNotMatch(written, /CORTEX_CLIENT_TOKEN/);
  assert.match(written, new RegExp(`CORTEX_WEBHOOK_TOKEN=${result.webhookToken}`));
});

test('ensureAuthTokens appends to an existing .env preserving prior content and newline', (t) => {
  const envPath = tmpEnvPath(t);
  // Pre-seed a file WITHOUT a trailing newline to exercise the newline guard.
  writeFileSync(envPath, '# Cortex Configuration\nCORTEX_MACHINE=lab2');
  const env: Record<string, string | undefined> = {};
  ensureAuthTokens({ envPath, env });
  const written = readFileSync(envPath, 'utf-8');
  // Prior content preserved.
  assert.match(written, /CORTEX_MACHINE=lab2/);
  // The appended key starts on its own line (no concatenation onto lab2).
  assert.doesNotMatch(written, /lab2CORTEX_/);
  assert.match(written, /\nCORTEX_CLIENT_TOKEN=/);
});

test('ignores blank/whitespace existing token values and regenerates', (t) => {
  const envPath = tmpEnvPath(t);
  const env: Record<string, string | undefined> = { CORTEX_CLIENT_TOKEN: '   ' };
  const result = ensureAuthTokens({ envPath, env });
  assert.match(result.clientToken, /^[0-9a-f]{64}$/);
  assert.ok(result.generated.includes('CORTEX_CLIENT_TOKEN'));
});
