// input:  task-operation tools with mocked loopback requests
// output: remote bash timeout and compact mutation response contracts
// pos:    MCP remote-operation boundary tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { requestLoopbackJson } from '../../../src/core/loopback-http.js';
import { registerTaskOpsTools } from '../../../src/domain/mcp/tools/task-ops.js';

vi.mock('../../../src/core/loopback-http.js', () => ({ requestLoopbackJson: vi.fn() }));
const requestMock = vi.mocked(requestLoopbackJson);

function captureRemoteTools(): Map<string, any[]> {
  const tools = new Map<string, any[]>();
  const fakeServer = {
    tool: (...args: any[]) => tools.set(args[0], args),
  };
  registerTaskOpsTools(fakeServer as any);
  return tools;
}

function captureRemoteMutationHandlers(): Map<string, (...args: any[]) => Promise<any>> {
  return new Map([...captureRemoteTools()].map(([name, args]) => [name, args.at(-1)]));
}

afterEach(() => requestMock.mockReset());

test('remote_bash accepts integer seconds and converts them only at the internal boundary', async () => {
  requestMock.mockResolvedValue({
    status: 200,
    body: { success: true, data: { stdout: '', stderr: '', exitCode: 0 } },
  });
  const tools = captureRemoteTools();
  const registration = tools.get('remote_bash')!;
  const schema = registration[2].timeout;
  const handler = registration.at(-1);

  assert.equal(schema.safeParse(1).success, true);
  assert.equal(schema.safeParse(600).success, true);
  assert.equal(schema.safeParse(0).success, false);
  assert.equal(schema.safeParse(1.5).success, false);
  assert.equal(schema.safeParse(601).success, false);

  await handler({ device: 'lab', command: 'true' }, {});
  await handler({ device: 'lab', command: 'true', timeout: 2 }, {});

  const bodies = requestMock.mock.calls.map((call) => call[2] as any);
  assert.equal(bodies[0].params.timeout, 120_000);
  assert.equal(bodies[0].timeout, 125_000);
  assert.equal(bodies[1].params.timeout, 2_000);
  assert.equal(bodies[1].timeout, 7_000);
});

test('remote_write and remote_edit return compact confirmations without file snapshots', async () => {
  const canary = 'PRIVATE_FILE_CONTENT_CANARY';
  requestMock.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      data: {
        success: true,
        cortexMDs: [],
        originalFile: canary,
        newContent: `${canary}-after`,
      },
    },
  });
  const handlers = captureRemoteMutationHandlers();

  const written = await handlers.get('remote_write')!(
    { device: 'lab', file_path: '/srv/x.md', content: 'after' },
    {},
  );
  const edited = await handlers.get('remote_edit')!(
    { device: 'lab', file_path: '/srv/x.md', old_string: 'before', new_string: 'after' },
    {},
  );

  assert.deepEqual(written, { content: [{ type: 'text', text: 'File written: /srv/x.md' }] });
  assert.deepEqual(edited, { content: [{ type: 'text', text: 'File edited: /srv/x.md' }] });
  assert.doesNotMatch(JSON.stringify([written, edited]), new RegExp(canary));
});
