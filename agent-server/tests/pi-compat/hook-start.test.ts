import { expect, test, vi } from 'vitest';
import { installHookBridge, type HookHost } from '../../src/agent-adapter/pi/hook-bridge.js';
import type { HookEntry } from '../../src/store/hook-registry.js';

const registry = vi.hoisted(() => ({ entries: [] as HookEntry[] }));
vi.mock('../../src/store/hook-registry.js', () => ({
  loadHookRegistry: () => registry.entries,
  filterHookEntries: (entries: HookEntry[]) => entries,
}));

type Handler = Parameters<HookHost['on']>[1];

function handlersFor(contexts: string[]): Handler[] {
  registry.entries = contexts.map((context, index) => ({
    id: `start-${index}`, event: 'agent:session-start',
    run: { command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { additionalContext: context } })}'` },
  } as HookEntry));
  const handlers: Handler[] = [];
  installHookBridge({ on: (_name, handler) => { handlers.push(handler); } }, {});
  return handlers;
}

test('getter-only SDK events chain returned context without mutating the event', async () => {
  const handlers = handlersFor(['first', 'second']);
  let current = 'base';
  for (const [index, handler] of handlers.entries()) {
    const original = current;
    const event = { prompt: 'go', get systemPrompt() { return original; } };
    const result = await handler(event, { cwd: '/tmp' }) as { systemPrompt: string };
    expect(event.systemPrompt).toBe(original);
    current = result.systemPrompt;
    expect(current).toBe(index === 0 ? 'base\n\nfirst' : 'base\n\nfirst\n\nsecond');
  }
});

test('getter-only SDK event returns undefined when hook adds no context', async () => {
  const [handler] = handlersFor(['']);
  const event = { get systemPrompt() { return 'base'; } };
  await expect(handler(event, { cwd: '/tmp' })).resolves.toBeUndefined();
  expect(event.systemPrompt).toBe('base');
});
