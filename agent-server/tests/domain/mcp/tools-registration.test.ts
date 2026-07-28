// input:  task-operation tool registration with mocked remote-command fetch
// output: compact remote mutation confirmations that never echo file snapshots
// pos:    MCP remote-write/edit response and data-leak contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { registerTaskOpsTools } from '../../../src/domain/mcp/tools/task-ops.js';

function captureRemoteMutationHandlers(): Map<string, (...args: any[]) => Promise<any>> {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const fakeServer = {
    tool: (...args: any[]) => handlers.set(args[0], args.at(-1)),
  };
  registerTaskOpsTools(fakeServer as any);
  return handlers;
}

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
