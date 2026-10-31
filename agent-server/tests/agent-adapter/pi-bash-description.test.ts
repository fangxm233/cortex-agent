import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { installDescribedBash, withDescription } from '../../src/agent-adapter/pi/bash-description.js';

function validate(parameters: unknown, args: Record<string, unknown>): unknown {
  return validateToolArguments(
    { name: 'bash', description: '', parameters } as any,
    { type: 'toolCall', id: 't1', name: 'bash', arguments: args } as any,
  );
}

test('the described bash takes an optional description and keeps timeout optional', () => {
  const bash = withDescription(createBashToolDefinition(process.cwd(), {}));
  assert.deepEqual((bash.parameters as any).required, ['command']);
  assert.equal((bash.parameters as any).properties.description.type, 'string');
  assert.deepEqual(validate(bash.parameters, { command: 'ls' }), { command: 'ls' });
  assert.deepEqual(validate(bash.parameters, { command: 'ls', description: 'List files' }), { command: 'ls', description: 'List files' });
  assert.equal(bash.name, 'bash');
});

test('the described bash runs the command as PI\'s own bash does', async () => {
  const bash = withDescription(createBashToolDefinition(process.cwd(), {}));
  const result = await bash.execute('t1', { command: 'echo hi', description: 'Say hi' } as any, undefined, undefined, undefined as any);
  assert.equal((result.content[0] as { text: string }).text.trim(), 'hi');
});

function mockPi(active: string[], settings: Record<string, unknown> = {}) {
  const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
  const registered: any[] = [];
  const pi: any = {
    on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.push(handler); },
    getActiveTools: () => active,
    getSettings: () => settings,
    registerTool: (tool: unknown) => { registered.push(tool); },
  };
  const start = async () => { for (const handler of handlers) await handler({ type: 'session_start' }, { cwd: '/work' }); };
  return { pi, registered, start };
}

test('a session with bash active gets the described bash, built with PI\'s shell settings', async () => {
  const factory = vi.fn(createBashToolDefinition);
  const { pi, registered, start } = mockPi(['read', 'bash'], { shellCommandPrefix: 'set -e', shellPath: '/bin/bash' });
  installDescribedBash(pi, async () => factory);
  await start();
  assert.deepEqual(factory.mock.calls[0], ['/work', { commandPrefix: 'set -e', shellPath: '/bin/bash' }]);
  assert.equal(registered.length, 1);
  assert.ok('description' in registered[0].parameters.properties);
});

test('a session without bash active is left without one', async () => {
  const load = vi.fn();
  const { pi, registered, start } = mockPi(['read', 'grep']);
  installDescribedBash(pi, load);
  await start();
  assert.equal(load.mock.calls.length, 0);
  assert.equal(registered.length, 0);
});
