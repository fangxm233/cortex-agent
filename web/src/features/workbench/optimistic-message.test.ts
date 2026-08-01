// input:  source-aware optimistic state, authority fixtures, deferred mutations
// output: stale-response, reconciliation, and failure regressions
// pos:    Optimistic Web sender contract specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it, vi } from 'vitest';
import type { SessionTranscript } from '@cortex-agent/ui-contract';
import { applyDelivered, buildTranscriptRows, type LiveSessionMessage, type PendingUserMessage } from './transcript-vm';
import { mergeRestoredDraft } from './composer-draft';
import {
  createOptimisticUserMessage,
  hasAuthoritativeMatch,
  promoteOptimisticUserMessage,
  reconcileOptimisticUserMessages,
  resolveOptimisticRejection,
  runOptimisticMutation,
  shouldSelectCreatedSession,
  type OptimisticUserMessage,
  type UserMessageAuthority,
} from './optimistic-message';

const T0 = '2026-08-01T01:00:00.000Z';
const T1 = '2026-08-01T01:00:01.000Z';
const T2 = '2026-08-01T01:00:02.000Z';

function transcript(messages: SessionTranscript['turns'][number]['messages'] = []): SessionTranscript {
  return { sessionId: 's1', turns: messages.length ? [{ turnIndex: 0, messages }] : [], pendingUserMessages: [] };
}

function user(text: string, ts: string) {
  return { type: 'user' as const, text, toolName: null, toolInput: null, ts, elapsedMs: null };
}

function authority(overrides: Partial<UserMessageAuthority> = {}): UserMessageAuthority {
  return { transcript: transcript(), liveTail: [], pendingUser: [], ...overrides };
}

function optimistic(
  text: string,
  current: OptimisticUserMessage[] = [],
  source: UserMessageAuthority = authority(),
  id = `local-${current.length + 1}`,
): OptimisticUserMessage {
  return createOptimisticUserMessage({
    clientId: id,
    target: { kind: 'session', sessionId: 's1' },
    text,
    ts: current.length === 0 ? T0 : T1,
  }, current, source);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function renderedUsers(messages: OptimisticUserMessage[], source: UserMessageAuthority): string[] {
  const reconciled = reconcileOptimisticUserMessages(messages, source);
  return buildTranscriptRows(source.transcript, source.liveTail, { pendingUser: reconciled.pendingUser })
    .filter((row) => row.kind === 'user')
    .map((row) => row.kind === 'user' ? row.text : '');
}

describe('runOptimisticMutation', () => {
  it.each([
    { target: { kind: 'session' as const, sessionId: 's1' }, result: { accepted: true } },
    { target: { kind: 'draft' as const, projectId: 'atlas' }, result: { sessionId: 's-new' } },
  ])('enqueues a renderable $target.kind row before its mutation promise settles', async ({ target, result }) => {
    const gate = deferred<typeof result>();
    let ledger: OptimisticUserMessage[] = [];
    const message = createOptimisticUserMessage({ clientId: 'local-1', target, text: 'hello now', ts: T0 }, [], authority());
    const settled = runOptimisticMutation({
      message,
      mutate: () => gate.promise,
      onEnqueue: (entry) => { ledger = [...ledger, entry]; },
      onAccepted: vi.fn(),
      onRejected: vi.fn(() => true),
    });

    expect(ledger).toEqual([message]);
    expect(renderedUsers(ledger, authority())).toEqual(['hello now']);

    gate.resolve(result);
    await expect(settled).resolves.toMatchObject({ ok: true, data: result });
  });

  it('removes an unconfirmed row and restores its draft when the deferred mutation rejects', async () => {
    const gate = deferred<{ accepted: boolean }>();
    const message = optimistic('restore me');
    let ledger: OptimisticUserMessage[] = [];
    const settled = runOptimisticMutation({
      message,
      mutate: () => gate.promise,
      onEnqueue: (entry) => { ledger = [...ledger, entry]; },
      onAccepted: vi.fn(),
      onRejected: (entry) => {
        const resolution = resolveOptimisticRejection(ledger, entry.clientId, authority());
        ledger = resolution.messages;
        return resolution.restore;
      },
    });

    gate.reject(new Error('offline'));
    const result = await settled;
    const restored = mergeRestoredDraft(
      { text: 'typed meanwhile', attachments: [] },
      { text: message.text, attachments: message.attachments ?? [] },
    );

    expect(result).toMatchObject({ ok: false, restore: true, error: { message: 'offline' } });
    expect(ledger).toEqual([]);
    expect(restored.text).toBe('restore me\ntyped meanwhile');
  });
});

describe('optimistic user reconciliation', () => {
  it.each([
    ['ordinary live event', authority({ liveTail: [{ sessionId: 's1', role: 'user', text: 'hello', ts: T1 }] })],
    ['transcript update', authority({ transcript: transcript([user('hello', T1)]) })],
    ['server pending event', authority({ pendingUser: [{ id: 'pin-1', text: 'hello', ts: T1 }] })],
  ] satisfies Array<[string, UserMessageAuthority]>)('replaces the local row with one %s row', (_label, source) => {
    const local = optimistic('hello');
    const reconciled = reconcileOptimisticUserMessages([local], source);

    expect(renderedUsers([local], source)).toEqual(['hello']);
    expect(reconciled.matchedClientIds).toEqual(['local-1']);
  });

  it('keeps exactly one row through pending, delivered, ordinary, and transcript updates', () => {
    const local = optimistic('change direction');
    const serverPending: PendingUserMessage[] = [{ id: 'pin-1', text: 'change direction', ts: T1 }];
    const pendingSource = authority({ pendingUser: serverPending });
    const delivered = applyDelivered(serverPending, { sessionId: 's1', pendingId: 'pin-1', committedTs: T2 });
    const deliveredSource = authority({ liveTail: delivered.committed ? [delivered.committed] : [], pendingUser: delivered.pending });
    const ordinaryAndTranscript = authority({
      transcript: transcript([user('change direction', T2)]),
      liveTail: [{ sessionId: 's1', role: 'user', text: 'change direction', ts: T2 }],
    });

    expect(renderedUsers([local], pendingSource)).toEqual(['change direction']);
    expect(renderedUsers([local], deliveredSource)).toEqual(['change direction']);
    expect(renderedUsers([local], ordinaryAndTranscript)).toEqual(['change direction']);
  });

  it('keeps the local fallback through pending and stale snapshots, then settles on commit', () => {
    const local = optimistic('overtake');
    const pending = authority({ pendingUser: [{ id: 'pin-1', text: 'overtake', ts: T1 }] });
    const pendingResult = reconcileOptimisticUserMessages([local], pending);
    const retainedLedger = [local].filter((entry) => !pendingResult.settledClientIds.includes(entry.clientId));

    expect(pendingResult.matchedClientIds).toEqual(['local-1']);
    expect(pendingResult.settledClientIds).toEqual([]);
    expect(renderedUsers(retainedLedger, authority())).toEqual(['overtake']);

    const committed = authority({ transcript: transcript([user('overtake', T2)]) });
    expect(reconcileOptimisticUserMessages(retainedLedger, committed).settledClientIds).toEqual(['local-1']);
    expect(renderedUsers(retainedLedger, committed)).toEqual(['overtake']);
  });

  it('treats a pending event as proof of acceptance when the HTTP mutation later rejects', () => {
    const local = optimistic('accepted despite HTTP');
    const pending = authority({ pendingUser: [{ id: 'pin-1', text: local.text, ts: T1 }] });
    const confirmed = resolveOptimisticRejection([local], local.clientId, pending);
    const failed = resolveOptimisticRejection([local], local.clientId, authority());

    expect(confirmed.restore).toBe(false);
    expect(confirmed.messages).toHaveLength(1);
    expect(renderedUsers(confirmed.messages, authority())).toEqual(['accepted despite HTTP']);
    expect(failed).toEqual({ messages: [], restore: true });
  });

  it('does not duplicate when delivered overtakes the pending event', () => {
    const local = optimistic('delivered first');
    const unknownDelivery = applyDelivered([], { sessionId: 's1', pendingId: 'pin-1', committedTs: T2 });
    const deliveredFirst = authority({
      liveTail: unknownDelivery.committed ? [unknownDelivery.committed] : [], pendingUser: unknownDelivery.pending,
    });
    const latePending = authority({ pendingUser: [{ id: 'pin-1', text: 'delivered first', ts: T1 }] });

    expect(unknownDelivery.committed).toBeNull();
    expect(renderedUsers([local], deliveredFirst)).toEqual(['delivered first']);
    expect(renderedUsers([local], latePending)).toEqual(['delivered first']);

    const committed = authority({ transcript: transcript([user('delivered first', T2)]) });
    expect(reconcileOptimisticUserMessages([local], committed).settledClientIds).toEqual(['local-1']);
    expect(renderedUsers([local], committed)).toEqual(['delivered first']);
  });

  it('allows modest browser/server clock skew when a new live occurrence arrives', () => {
    const local = optimistic('skewed');
    const serverBehind = authority({
      liveTail: [{ sessionId: 's1', role: 'user', text: 'skewed', ts: '2026-08-01T00:59:30.000Z' }],
    });

    expect(reconcileOptimisticUserMessages([local], serverBehind).matchedClientIds).toEqual(['local-1']);
  });

  it('does not let a recent older transcript response consume a send made while it was loading', () => {
    const local = optimistic('same');
    const lateOld = authority({ transcript: transcript([user('same', '2026-08-01T00:59:30.000Z')]) });
    const reconciled = reconcileOptimisticUserMessages([local], lateOld);

    expect(reconciled.matchedClientIds).toEqual([]);
    expect(reconciled.settledClientIds).toEqual([]);
    expect(renderedUsers([local], lateOld)).toEqual(['same', 'same']);
  });

  it('does not let a much older identical transcript response consume a new send', () => {
    const local = optimistic('same');
    const lateOld = authority({ transcript: transcript([user('same', '2026-07-31T23:00:00.000Z')]) });

    expect(reconcileOptimisticUserMessages([local], lateOld).matchedClientIds).toEqual([]);
    expect(renderedUsers([local], lateOld)).toEqual(['same', 'same']);
  });

  it('does not count a late stale row toward two identical sends', () => {
    const first = optimistic('same', [], authority(), 'local-1');
    const second = optimistic('same', [first], authority(), 'local-2');
    const staleAndOneNew = authority({ transcript: transcript([
      user('same', '2026-08-01T00:59:30.000Z'),
      user('same', T1),
    ]) });
    const reconciled = reconcileOptimisticUserMessages([first, second], staleAndOneNew);

    expect(reconciled.matchedClientIds).toEqual(['local-1']);
    expect(reconciled.settledClientIds).toEqual(['local-1']);
    expect(renderedUsers([first, second], staleAndOneNew)).toEqual(['same', 'same', 'same']);
  });

  it('does not reuse one new occurrence when stale authority arrives between identical sends', () => {
    const stale = authority({ transcript: transcript([user('same', '2026-08-01T00:59:30.000Z')]) });
    const first = optimistic('same', [], authority(), 'local-1');
    const second = optimistic('same', [first], stale, 'local-2');
    const staleAndOneNew = authority({ transcript: transcript([
      user('same', '2026-08-01T00:59:30.000Z'),
      user('same', T1),
    ]) });
    const reconciled = reconcileOptimisticUserMessages([first, second], staleAndOneNew);

    expect(reconciled.matchedClientIds).toEqual(['local-1']);
    expect(reconciled.settledClientIds).toEqual(['local-1']);
    expect(renderedUsers([first, second], staleAndOneNew)).toEqual(['same', 'same', 'same']);
  });

  it('matches identical sends one occurrence at a time without consuming an older identical row', () => {
    const oldSource = authority({ transcript: transcript([user('same', '2026-07-31T23:00:00.000Z')]) });
    const first = optimistic('same', [], oldSource, 'local-1');
    const second = optimistic('same', [first], oldSource, 'local-2');

    expect(first.authorityOrdinal).toBe(2);
    expect(second.authorityOrdinal).toBe(3);
    expect(renderedUsers([first, second], oldSource)).toEqual(['same', 'same', 'same']);

    const oneNew = authority({ transcript: transcript([
      user('same', '2026-07-31T23:00:00.000Z'),
      user('same', T1),
    ]) });
    const twoNew = authority({ transcript: transcript([
      user('same', '2026-07-31T23:00:00.000Z'),
      user('same', T1),
      user('same', T2),
    ]) });

    expect(reconcileOptimisticUserMessages([first, second], oneNew).matchedClientIds).toEqual(['local-1']);
    expect(renderedUsers([first, second], oneNew)).toEqual(['same', 'same', 'same']);
    expect(reconcileOptimisticUserMessages([first, second], twoNew).matchedClientIds).toEqual(['local-1', 'local-2']);
    expect(renderedUsers([first, second], twoNew)).toEqual(['same', 'same', 'same']);
  });

  it('does not reconcile against another session and promotes one draft row to its created session', () => {
    const draft = createOptimisticUserMessage({
      clientId: 'local-draft', target: { kind: 'draft', projectId: 'atlas' }, text: 'first', ts: T0,
    }, [], authority());
    const promoted = promoteOptimisticUserMessage([draft], 'local-draft', 's-new')[0];
    const otherSessionLive: LiveSessionMessage[] = [{ sessionId: 'other', role: 'user', text: 'first', ts: T1 }];

    expect(promoted.target).toEqual({ kind: 'session', sessionId: 's-new' });
    expect(shouldSelectCreatedSession(draft, 'atlas', true)).toBe(true);
    expect(shouldSelectCreatedSession(draft, 'orchard', true)).toBe(false);
    expect(shouldSelectCreatedSession(draft, 'atlas', false)).toBe(false);
    expect(hasAuthoritativeMatch(promoted, authority({ liveTail: otherSessionLive }))).toBe(false);
    expect(hasAuthoritativeMatch(promoted, authority({
      transcript: { ...transcript([user('first', T1)]), sessionId: 's-new' },
    }))).toBe(true);
  });

  it('preserves attachment-only payloads while replacing the local row', () => {
    const attachments = [{ name: 'a.png', path: 'workspace/a.png', size: 3, mimeType: 'image/png', type: 'image' as const }];
    const local = createOptimisticUserMessage({
      clientId: 'local-file', target: { kind: 'session', sessionId: 's1' }, text: '', attachments, ts: T0,
    }, [], authority());
    const source = authority({ pendingUser: [{ id: 'pin-file', text: '', attachments, ts: T1 }] });
    const reconciled = reconcileOptimisticUserMessages([local], source);

    expect(reconciled.pendingUser).toEqual([{ id: 'pin-file', text: '', attachments, ts: T1 }]);
    expect(reconciled.matchedClientIds).toEqual(['local-file']);
  });

  it('matches a create-and-send attachment after the server moves it into the real session directory', () => {
    const draftAttachment = [{ name: 'a.png', path: 'tmp/attachments/draft/a.png', size: 3, mimeType: 'image/png', type: 'image' as const }];
    const committedAttachment = [{ ...draftAttachment[0], path: 'workspace/attachments/s-new/a.png' }];
    const draft = createOptimisticUserMessage({
      clientId: 'local-file', target: { kind: 'draft', projectId: 'atlas' }, text: '', attachments: draftAttachment, ts: T0,
    }, [], authority());
    const promoted = promoteOptimisticUserMessage([draft], draft.clientId, 's-new')[0];
    const source = authority({
      transcript: {
        sessionId: 's-new', pendingUserMessages: [],
        turns: [{ turnIndex: 0, messages: [{ ...user('', T1), attachments: committedAttachment }] }],
      },
    });

    expect(promoted.attachments?.[0].path).toBe('attachments/s-new/a.png');
    expect(reconcileOptimisticUserMessages([promoted], source).matchedClientIds).toEqual(['local-file']);
  });
});
