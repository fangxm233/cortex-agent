import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EngineInjections } from '../../src/agent-adapter/engine-injections.js';
import { RunEventQueue, type RunEvent } from '../../src/agent-adapter/run-events.js';
import type { InjectionAckSink, UserMessage } from '../../src/agent-adapter/types.js';

function fakeSession(accepts = true) {
  const state = { sink: null as InjectionAckSink | null, injected: [] as string[] };
  return {
    state,
    injectUserMessage: (message: UserMessage) => { state.injected.push(message.text); return accepts; },
    setInjectionAckSink: (sink: InjectionAckSink) => { state.sink = sink; },
  };
}

async function drain(queue: RunEventQueue): Promise<RunEvent[]> {
  queue.close();
  const events: RunEvent[] = [];
  for (let next = await queue.next(); !next.done; next = await queue.next()) events.push(next.value);
  return events;
}

test('acks correlate to the ids steer handed out, first in first out per text', async () => {
  const session = fakeSession();
  const injections = new EngineInjections(session, 'x-inj');
  const queue = new RunEventQueue();
  injections.beginRun(queue);
  const first = injections.steer({ text: 'same' });
  const second = injections.steer({ text: 'same' });
  session.state.sink!.onDelivered({ text: 'same', foldedIntoTurn: true });
  session.state.sink!.onUndelivered({ text: 'same' });
  session.state.sink!.onDelivered({ text: 'never injected', foldedIntoTurn: false });
  assert.deepEqual(await drain(queue), [
    { type: 'injection_delivered', injectionId: first.injectionId, foldedIntoTurn: true },
    { type: 'injection_rejected', injectionId: second.injectionId, reason: 'undelivered' },
    { type: 'injection_delivered', injectionId: 'x-inj-3', foldedIntoTurn: false },
  ]);
});

test('a refusal is surfaced on the run stream; an accepted injection is owed to the phase', async () => {
  const noted: string[] = [];
  const ingested: RunEvent[] = [];
  const phase = { noteInjectionAccepted: () => noted.push('owed'), ingest: (e: RunEvent) => ingested.push(e) };
  const refusing = new EngineInjections(fakeSession(false), 'r');
  const refusedQueue = new RunEventQueue();
  refusing.beginRun(refusedQueue).attachPhase(phase as any);
  assert.deepEqual(refusing.steer({ text: 'no' }, 'caller-id'), { accepted: false, injectionId: 'caller-id' });
  assert.deepEqual(await drain(refusedQueue), [{ type: 'injection_rejected', injectionId: 'caller-id', reason: 'refused' }]);

  const session = fakeSession();
  const accepting = new EngineInjections(session, 'a');
  accepting.beginRun(new RunEventQueue()).attachPhase(phase as any);
  const steered = accepting.steer({ text: 'yes' });
  session.state.sink!.onDelivered({ text: 'yes', foldedIntoTurn: false });
  assert.deepEqual(noted, ['owed']);
  assert.deepEqual(ingested, [{ type: 'injection_delivered', injectionId: steered.injectionId, foldedIntoTurn: false }]);
});

test('out-of-band events need a live run, and the newest run owns the slot', async () => {
  const injections = new EngineInjections(fakeSession(), 'o');
  const event: RunEvent = { type: 'phase', phase: 'done', pendingBackground: 0, undeliveredBackground: 0 };
  assert.equal(injections.pushOutOfBand(event), false);
  const older = new RunEventQueue();
  injections.beginRun(older);
  const newer = new RunEventQueue();
  injections.beginRun(newer);
  assert.equal(injections.pushOutOfBand(event), true);
  assert.deepEqual(await drain(older), []);
  assert.deepEqual(await drain(newer), [event]);
});
