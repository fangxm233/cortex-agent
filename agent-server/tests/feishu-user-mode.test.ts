// input:  node:test, feishu/client (wrapWithUserToken, buildFeishuClientFromEnv)
// output: TDD spec for user-identity injection on MCP doc calls + FEISHU_AUTH_MODE switch
// pos:    Verifies user mode attaches user_access_token to every leaf SDK call (no per-call-site
//         edits) and that mode/credential gating returns the right client (or null).
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as lark from '@larksuiteoapi/node-sdk';
import { wrapWithUserToken, buildFeishuClientFromEnv } from '../src/domain/mcp/feishu/client.js';

/** Pull the token value out of a lark request option object ({ lark: { [sym]: token } }). */
function tokenFromOptions(options: any): unknown {
  if (!options || !options.lark) return undefined;
  const syms = Object.getOwnPropertySymbols(options.lark);
  return syms.length ? options.lark[syms[0]] : undefined;
}

function nestedMockClient() {
  const calls: any[] = [];
  return {
    calls,
    client: {
      docx: { v1: { document: {
        create: async (payload: any, options: any) => { calls.push({ payload, options }); return { code: 0, data: { ok: true } }; },
      } } },
      drive: { v1: { permissionPublic: {
        patch: async (payload: any, options: any) => { calls.push({ payload, options }); return { code: 0 }; },
      } } },
    } as any,
  };
}

test('wrapWithUserToken injects the user_access_token into every leaf call', async () => {
  const { client, calls } = nestedMockClient();
  let provided = 0;
  const wrapped = wrapWithUserToken(client, async () => { provided++; return 'UTOK'; });

  const res = await wrapped.docx.v1.document.create({ title: 'T' } as any);
  assert.deepEqual(res, { code: 0, data: { ok: true } });          // return value preserved
  assert.equal(provided, 1);                                        // token provider invoked
  assert.deepEqual(calls[0].payload, { title: 'T' });               // payload passed through
  assert.equal(tokenFromOptions(calls[0].options), 'UTOK');         // token attached

  await wrapped.drive.v1.permissionPublic.patch({ token: 'x' } as any);
  assert.equal(provided, 2);
  assert.equal(tokenFromOptions(calls[1].options), 'UTOK');
});

test('wrapWithUserToken fetches a fresh token per call (so refresh is picked up)', async () => {
  const { client, calls } = nestedMockClient();
  const seq = ['T1', 'T2'];
  let i = 0;
  const wrapped = wrapWithUserToken(client, async () => seq[i++]);
  await wrapped.docx.v1.document.create({});
  await wrapped.docx.v1.document.create({});
  assert.equal(tokenFromOptions(calls[0].options), 'T1');
  assert.equal(tokenFromOptions(calls[1].options), 'T2');
});

test('wrapWithUserToken propagates token-provider errors to the caller', async () => {
  const { client } = nestedMockClient();
  const wrapped = wrapWithUserToken(client, async () => { throw new Error('Run cortex feishu login'); });
  await assert.rejects(wrapped.docx.v1.document.create({}), /cortex feishu login/);
});

test('lark.withUserAccessToken is the shape we rely on', () => {
  const opt = lark.withUserAccessToken('ZZ');
  assert.equal(tokenFromOptions(opt), 'ZZ');
});

// ── buildFeishuClientFromEnv mode + credential gating ────────────

test('buildFeishuClientFromEnv returns null without app credentials (any mode)', () => {
  assert.equal(buildFeishuClientFromEnv({ FEISHU_AUTH_MODE: 'user' } as any), null);
  assert.equal(buildFeishuClientFromEnv({ FEISHU_AUTH_MODE: 'bot' } as any), null);
  assert.equal(buildFeishuClientFromEnv({} as any), null);
});

test('buildFeishuClientFromEnv returns a client in bot mode (default)', () => {
  const c = buildFeishuClientFromEnv({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' } as any);
  assert.ok(c, 'expected a client');
});

test('buildFeishuClientFromEnv returns a client in user mode', () => {
  const c = buildFeishuClientFromEnv({ FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_AUTH_MODE: 'user' } as any);
  assert.ok(c, 'expected a wrapped client');
});
