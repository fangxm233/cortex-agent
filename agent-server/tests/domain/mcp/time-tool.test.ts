// input:  registerTimeTools from domain/mcp/tools/time
// output: current_time handler returns valid time payload + handles bad timezone
// pos:    behavioral guard for the current_time MCP tool
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { registerTimeTools } from '../../../src/domain/mcp/tools/time.js';

// Capture the handler registered via server.tool(name, desc, schema, meta, handler).
function captureHandler(): (input: { timezone?: string }) => Promise<any> {
  let handler: any;
  const fakeServer: any = {
    tool: (_name: string, _desc: string, _schema: any, _meta: any, fn: any) => {
      handler = fn;
    },
  };
  registerTimeTools(fakeServer);
  assert.ok(handler, 'current_time handler was registered');
  return handler;
}

test('current_time returns local/utc/unix fields for a valid timezone', async () => {
  const handler = captureHandler();
  const res = await handler({ timezone: 'Asia/Shanghai' });
  assert.notEqual(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.timezone, 'Asia/Shanghai');
  assert.match(payload.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(payload.iso_utc, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(typeof payload.unix_ms, 'number');
  assert.match(payload.offset, /^UTC/);
});

test('current_time defaults to a timezone when none given', async () => {
  const handler = captureHandler();
  const res = await handler({});
  assert.notEqual(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.timezone && payload.timezone.length > 0);
});

test('current_time reports an error for an invalid timezone', async () => {
  const handler = captureHandler();
  const res = await handler({ timezone: 'Not/AZone' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid timezone/);
});
