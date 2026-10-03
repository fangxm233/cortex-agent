import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ExecutionRepo, executionRepo } from '../../../src/store/execution-repo.js';
import { registerExecutionTools } from '../../../src/domain/mcp/tools/executions.js';

type QueryInput = { execution_id?: string; status?: string; project?: string; limit?: number };

function captureHandler(): (input: QueryInput) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  let handler: any;
  const fakeServer: any = {
    tool: (_name: string, _desc: string, _schema: unknown, _meta: unknown, fn: unknown) => { handler = fn; },
  };
  registerExecutionTools(fakeServer);
  assert.ok(handler, 'query_executions handler was registered');
  return handler;
}

test('query_executions in the sidecar answers from the file as it is at call time', async () => {
  // The stdio sidecar follows the file; the daemon is a separate writer of the same file.
  const daemon = new ExecutionRepo({ filePath: executionRepo.filePath });
  await daemon.flush();
  executionRepo.follow();
  const query = captureHandler();

  assert.match((await query({})).content[0].text, /No running executions found/);

  const run = daemon.startLocalExecution({ kind: 'local', channel: 'web:s1', project: 'proj', sessionId: 's1', label: 'later run' });
  await daemon.flush();
  const listed = (await query({})).content[0].text;
  assert.match(listed, new RegExp(`\\[${run.id}\\] running`));

  daemon.completeExecution(run.id, { costUsd: 0.25, numTurns: 2 });
  await daemon.flush();
  const detail = await query({ execution_id: run.id });
  assert.notEqual(detail.isError, true);
  assert.match(detail.content[0].text, new RegExp(`\\[${run.id}\\] completed`));
  assert.match(detail.content[0].text, /Cost: \$0\.2500/);
  assert.match((await query({})).content[0].text, /No running executions found/);
});
