// input:  node:test, feishu/client (stderrLogger)
// output: assert lark SDK logging is routed to stderr, never stdout (MCP stdio safety)
// pos:    Regression: the cortex-feishu MCP server speaks JSON-RPC over stdout; any lark
//         SDK log to stdout corrupts the protocol. client.ts must force stderr.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { stderrLogger } from '../src/domain/mcp/feishu/client.js';

function captureStreams(fn: () => void): { out: string; err: string } {
  let out = '', err = '';
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (c: any) => { out += String(c); return true; };
  (process.stderr as any).write = (c: any) => { err += String(c); return true; };
  try { fn(); } finally {
    (process.stdout as any).write = o;
    (process.stderr as any).write = e;
  }
  return { out, err };
}

test('every stderrLogger level writes to stderr and NOT stdout', () => {
  for (const m of ['error', 'warn', 'info', 'debug', 'trace'] as const) {
    const { out, err } = captureStreams(() => stderrLogger[m]('client ready', { a: 1 }));
    assert.equal(out, '', `${m} must not write to stdout (would corrupt MCP protocol)`);
    assert.ok(err.length > 0, `${m} must write to stderr`);
  }
});
