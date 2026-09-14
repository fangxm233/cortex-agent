// input:  a stub PI session and the mid-turn trigger percent
// output: mid-turn compaction decisions, replacement context and degradation tests
// pos:    PI mid-turn context guard contract
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  installPiContextGuard,
  type GuardPrepareNextTurn,
  type GuardSessionLike,
  type GuardTurnContext,
} from '../../src/agent-adapter/pi/context-guard.js';

interface StubOptions {
  percent?: number | null;
  contextWindow?: number;
  compactionEnabled?: boolean;
  isCompacting?: boolean;
  /** Result of `_runAutoCompaction`; an Error makes it reject. */
  compaction?: boolean | Error;
  /** Omit the PI-internal compaction entry point (an SDK that no longer exposes it). */
  withoutAutoCompaction?: boolean;
  previous?: GuardPrepareNextTurn;
}

interface Stub {
  session: GuardSessionLike;
  calls: { reason: string; willRetry: boolean }[];
  /** Messages PI's compaction rebuilt the state with. */
  compacted: unknown[];
}

function stubSession(options: StubOptions = {}): Stub {
  const calls: Stub['calls'] = [];
  const compacted = [{ role: 'user' }, { role: 'toolResult' }];
  const session: GuardSessionLike = {
    agent: {
      prepareNextTurnWithContext: options.previous,
      state: { messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'toolResult' }] },
    },
    settingsManager: {
      getCompactionSettings: () => ({ enabled: options.compactionEnabled !== false }),
    },
    isCompacting: options.isCompacting === true,
    getContextUsage: () => ({
      tokens: 100,
      contextWindow: options.contextWindow ?? 200_000,
      percent: options.percent === undefined ? 90 : options.percent,
    }),
    _runAutoCompaction: async (reason, willRetry) => {
      calls.push({ reason, willRetry });
      if (options.compaction instanceof Error) throw options.compaction;
      const ok = options.compaction !== false;
      if (ok) session.agent.state.messages = compacted;
      return ok;
    },
  };
  if (options.withoutAutoCompaction) delete session._runAutoCompaction;
  return { session, calls, compacted };
}

const TURN: GuardTurnContext = {
  message: { content: [{ type: 'text' }, { type: 'toolCall', id: 't1' }] },
  context: { systemPrompt: 'base', messages: ['stale'] },
};

function hookOf(session: GuardSessionLike): GuardPrepareNextTurn {
  const hook = session.agent.prepareNextTurnWithContext;
  assert.ok(hook, 'guard must install a next-turn hook');
  return hook;
}

describe('pi mid-turn context guard', () => {
  test('leaves the turn alone below the trigger percent', async () => {
    const { session, calls } = stubSession({ percent: 70 });
    const previousSnapshot = { model: 'm' };
    session.agent.prepareNextTurnWithContext = () => previousSnapshot;
    const guard = installPiContextGuard(session, { percent: () => 88 });
    assert.ok(guard);
    const result = await hookOf(session)(TURN, undefined);
    assert.equal(result, previousSnapshot);
    assert.deepEqual(calls, []);
  });

  test('runs PI compaction and hands the loop a copy of the rebuilt messages', async () => {
    const { session, calls, compacted } = stubSession({ percent: 91 });
    installPiContextGuard(session, { percent: () => 88 });
    const result = await hookOf(session)(TURN, undefined);
    assert.deepEqual(calls, [{ reason: 'threshold', willRetry: false }]);
    const messages = (result?.context as { messages: unknown[] }).messages;
    assert.deepEqual(messages, compacted);
    assert.notEqual(messages, session.agent.state.messages, 'must not share the live state array');
    assert.equal((result?.context as { systemPrompt: string }).systemPrompt, 'base');
  });

  test('keeps the fields the previous hook returned', async () => {
    const { session } = stubSession({
      percent: 95,
      previous: () => ({ model: 'pi-model', context: { systemPrompt: 'refreshed', tools: ['bash'] } }),
    });
    installPiContextGuard(session, { percent: () => 88 });
    const result = await hookOf(session)(TURN, undefined);
    assert.equal(result?.model, 'pi-model');
    const context = result?.context as { systemPrompt: string; tools: string[]; messages: unknown[] };
    assert.equal(context.systemPrompt, 'refreshed');
    assert.deepEqual(context.tools, ['bash']);
    assert.equal(context.messages.length, 2);
  });

  test('stays out of the way when it must not compact', async () => {
    const cases: StubOptions[] = [
      { percent: null },                       // right after a compaction: usage unknown
      { percent: 95, compactionEnabled: false }, // PI's own compaction is switched off
      { percent: 95, isCompacting: true },      // a compaction is already running
    ];
    for (const options of cases) {
      const { session, calls } = stubSession(options);
      installPiContextGuard(session, { percent: () => 88 });
      await hookOf(session)(TURN, undefined);
      assert.deepEqual(calls, [], JSON.stringify(options));
    }
  });

  test('ignores a turn that ended without a tool call, and an aborted run', async () => {
    const { session, calls } = stubSession({ percent: 95 });
    installPiContextGuard(session, { percent: () => 88 });
    await hookOf(session)({ message: { content: [{ type: 'text' }] }, context: {} }, undefined);
    assert.deepEqual(calls, []);
    await hookOf(session)(TURN, AbortSignal.abort());
    assert.deepEqual(calls, []);
  });

  test('percent 0 disables the check entirely', async () => {
    const { session, calls } = stubSession({ percent: 99 });
    installPiContextGuard(session, { percent: () => 0 });
    await hookOf(session)(TURN, undefined);
    assert.deepEqual(calls, []);
  });

  test('a failed compaction is reported once and not retried in the same turn', async () => {
    const { session, calls } = stubSession({ percent: 95, compaction: new Error('summary 500') });
    const seen: { percentBefore: number; ok: boolean }[] = [];
    const guard = installPiContextGuard(session, {
      percent: () => 88,
      onCompacted: (info) => seen.push(info),
    });
    const first = await hookOf(session)(TURN, undefined);
    assert.equal(first, undefined, 'the turn continues on the context it already had');
    await hookOf(session)(TURN, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(seen, [{ percentBefore: 95, ok: false }]);
    guard?.resetTurn();
    await hookOf(session)(TURN, undefined);
    assert.equal(calls.length, 2, 'a new Cortex turn may try again');
  });

  test('a PI build without the internal entry point is left untouched', () => {
    const { session } = stubSession({ withoutAutoCompaction: true });
    const previous = session.agent.prepareNextTurnWithContext;
    assert.equal(installPiContextGuard(session, { percent: () => 88 }), null);
    assert.equal(session.agent.prepareNextTurnWithContext, previous);
  });

  // The guard drives one PI-internal method. A rename there must fail loudly here rather than
  // silently degrade every PI turn back to "no mid-turn check at all".
  test('the installed PI SDK still exposes what the guard drives', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const proto = sdk.AgentSession.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof proto._runAutoCompaction, 'function');
    assert.equal(typeof proto.getContextUsage, 'function');
    assert.equal(
      typeof Object.getOwnPropertyDescriptor(proto, 'isCompacting')?.get,
      'function',
    );
  });

  test('dispose restores the hook PI installed', async () => {
    const previous: GuardPrepareNextTurn = () => ({ model: 'pi-model' });
    const { session, calls } = stubSession({ percent: 95, previous });
    const guard = installPiContextGuard(session, { percent: () => 88 });
    guard?.dispose();
    assert.equal(session.agent.prepareNextTurnWithContext, previous);
    await hookOf(session)(TURN, undefined);
    assert.deepEqual(calls, []);
  });
});
