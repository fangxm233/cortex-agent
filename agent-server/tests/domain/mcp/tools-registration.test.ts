// input:  task-operation tool registration with mocked remote-command fetch
// output: remote bash timeout and compact mutation response contracts
// pos:    MCP remote-operation boundary tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { registerTaskOpsTools } from '../../../src/domain/mcp/tools/task-ops.js';

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

afterEach(() => vi.restoreAllMocks());

test('remote_bash accepts integer seconds and converts them only at the internal boundary', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ success: true, data: { stdout: '', stderr: '', exitCode: 0 } }),
  } as Response);
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

  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  assert.equal(bodies[0].params.timeout, 120_000);
  assert.equal(bodies[0].timeout, 125_000);
  assert.equal(bodies[1].params.timeout, 2_000);
  assert.equal(bodies[1].timeout, 7_000);
});

test('remote_write and remote_edit return compact confirmations without file snapshots', async () => {
  const canary = 'PRIVATE_FILE_CONTENT_CANARY';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({
      success: true,
      data: {
        success: true,
        cortexMDs: [],
        originalFile: canary,
        newContent: `${canary}-after`,
      },
    }),
  } as Response);
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
