// input:  Vitest, commission-plan tool, mock HTTP transport, tmp contract files
// output: commission plan-exit payload and outcome-mapping regressions
// pos:    Tests the commission contract approval tool
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { runCommissionPlanExit } from '../../../src/domain/mcp/tools/commission-plan.js';
import type { InteractionToolDeps } from '../../../src/domain/mcp/tools/interaction-plan.js';

interface RecordedCall { url: string; body: any }

function makeMockHttp(responses: Array<{ status?: number; body: any }>): { post: InteractionToolDeps['httpPost']; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const post = async (url: string, body: any) => {
    calls.push({ url, body });
    const r = responses[i++] || { status: 200, body: {} };
    return { status: r.status ?? 200, body: r.body };
  };
  return { post, calls };
}

function makeDeps(overrides: Partial<InteractionToolDeps> = {}): InteractionToolDeps {
  return {
    channel: 'web:sess-1',
    sessionId: 'sess-1',
    threadId: null,
    webhookBaseUrl: 'http://127.0.0.1:3001',
    httpPost: async () => ({ status: 200, body: {} }),
    ...overrides,
  };
}

function writeContract(t: { onTestFinished: (fn: () => void) => void }): string {
  const p = path.join(os.tmpdir(), `cortex-contract-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(p, '# Contract\ngoal\n');
  t.onTestFinished(() => { try { fs.unlinkSync(p); } catch {} });
  return p;
}

test('posts contract content plus the commission payload to /hook/exit-plan-mode', async (t) => {
  const contractPath = writeContract(t);
  const { post, calls } = makeMockHttp([{ body: { approved: false, reason: '' } }]);
  await runCommissionPlanExit(
    { contract_file_path: contractPath, name: 'Ship It', summary: 'sum' },
    makeDeps({ httpPost: post }),
  );
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/hook/exit-plan-mode');
  assert.equal(calls[0].body.planContent, '# Contract\ngoal\n');
  assert.deepEqual(calls[0].body.commission, { name: 'Ship It', title: 'Ship It', contractPath });
  assert.equal(calls[0].body.toolInput.plan_file_path, contractPath);
});

test('approval with a successful finalize reports the final directory and binding', async (t) => {
  const contractPath = writeContract(t);
  const { post } = makeMockHttp([{
    body: { approved: true, reason: '', commission: { ok: true, commissionId: 'c1', slug: 'ship-it', dir: '/ctx/commissions/ship-it' } },
  }]);
  const result = await runCommissionPlanExit(
    { contract_file_path: contractPath, name: 'Ship It' },
    makeDeps({ httpPost: post }),
  );
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /Commission "ship-it" \(c1\) is registered/);
  assert.match(result.content[0].text, /\/ctx\/commissions\/ship-it/);
  assert.match(result.content[0].text, /ledger\.md/);
});

test('denial and pre-validation failure map to revise-and-retry outcomes', async (t) => {
  const contractPath = writeContract(t);
  const denied = makeMockHttp([{ body: { approved: false, reason: 'scope too big' } }]);
  const deniedResult = await runCommissionPlanExit(
    { contract_file_path: contractPath, name: 'x' }, makeDeps({ httpPost: denied.post }),
  );
  assert.ok(!deniedResult.isError, 'denial is an outcome, not a tool error');
  assert.match(deniedResult.content[0].text, /denied/);
  assert.match(deniedResult.content[0].text, /scope too big/);

  const invalid = makeMockHttp([{ body: { error: 'commission-invalid', message: 'bad draft dir' } }]);
  const invalidResult = await runCommissionPlanExit(
    { contract_file_path: contractPath, name: 'x' }, makeDeps({ httpPost: invalid.post }),
  );
  assert.ok(invalidResult.isError);
  assert.match(invalidResult.content[0].text, /bad draft dir/);
});

test('approval with a failed finalize surfaces the error as a tool error', async (t) => {
  const contractPath = writeContract(t);
  const { post } = makeMockHttp([{ body: { approved: true, commission: { ok: false, error: 'rename blew up' } } }]);
  const result = await runCommissionPlanExit(
    { contract_file_path: contractPath, name: 'x' }, makeDeps({ httpPost: post }),
  );
  assert.ok(result.isError);
  assert.match(result.content[0].text, /rename blew up/);
});

test('missing channel, name, or contract file fail before any webhook call', async (t) => {
  const contractPath = writeContract(t);
  const { post, calls } = makeMockHttp([]);
  const noChannel = await runCommissionPlanExit(
    { contract_file_path: contractPath, name: 'x' }, makeDeps({ channel: null, httpPost: post }),
  );
  const noName = await runCommissionPlanExit(
    { contract_file_path: contractPath, name: '  ' }, makeDeps({ httpPost: post }),
  );
  const noFile = await runCommissionPlanExit(
    { contract_file_path: '/nonexistent/contract.md', name: 'x' }, makeDeps({ httpPost: post }),
  );
  assert.ok(noChannel.isError && noName.isError && noFile.isError);
  assert.equal(calls.length, 0);
});
