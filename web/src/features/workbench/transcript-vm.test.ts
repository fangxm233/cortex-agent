import { describe, it, expect } from 'vitest';
import {
  buildTranscriptRows,
  liveToMessage,
  turnCount,
  currentTurnElapsedMs,
  formatElapsed,
  resolveRunning,
  resolveBackgroundRunning,
  resolveTurns,
  rewindStats,
  applyAssistantDelta,
  endStreamingBlock,
  type LiveSessionMessage,
  type StreamingBlock,
} from './transcript-vm';
import type { SessionTranscript } from '@cortex-agent/ui-contract';

const T = '2026-07-07T07:42:00.000Z';

function tx(turns: SessionTranscript['turns']): SessionTranscript {
  return { sessionId: 's1', turns };
}

describe('buildTranscriptRows', () => {
  it('empty transcript with no live tail → no rows', () => {
    expect(buildTranscriptRows(tx([]), [])).toEqual([]);
  });

  it('a user + assistant turn → divider, user bubble, assistant block', () => {
    const rows = buildTranscriptRows(
      tx([
        {
          turnIndex: 0,
          messages: [
            { type: 'user', text: 'hi there', toolName: null, toolInput: null, ts: T, elapsedMs: null },
            { type: 'assistant', text: 'hello back', toolName: null, toolInput: null, ts: T, elapsedMs: 1000 },
          ],
        },
      ]),
      [],
    );
    expect(rows[0].kind).toBe('divider');
    expect(rows[1]).toEqual({ kind: 'user', text: 'hi there', turnIndex: 0, ts: T });
    expect(rows[2]).toEqual({ kind: 'assistant', text: 'hello back', streaming: false });
  });

  it('consecutive tool messages collapse into one tools row with each call', () => {
    const rows = buildTranscriptRows(
      tx([
        {
          turnIndex: 0,
          messages: [
            { type: 'user', text: 'go', toolName: null, toolInput: null, ts: T, elapsedMs: null },
            { type: 'tool', text: null, toolName: 'read', toolInput: 'a.md', ts: T, elapsedMs: 0 },
            { type: 'tool', text: null, toolName: 'bash', toolInput: 'ls', ts: T, elapsedMs: 0 },
            { type: 'assistant', text: 'done', toolName: null, toolInput: null, ts: T, elapsedMs: 0 },
          ],
        },
      ]),
      [],
    );
    const tools = rows.find((r) => r.kind === 'tools');
    expect(tools).toEqual({
      kind: 'tools',
      count: 2,
      calls: [
        { kind: 'read', input: 'a.md' },
        { kind: 'bash', input: 'ls' },
      ],
    });
  });

  it('streaming flag marks only the last assistant row when streaming=true', () => {
    const rows = buildTranscriptRows(
      tx([
        {
          turnIndex: 0,
          messages: [
            { type: 'assistant', text: 'first', toolName: null, toolInput: null, ts: T, elapsedMs: null },
            { type: 'assistant', text: 'second', toolName: null, toolInput: null, ts: T, elapsedMs: 0 },
          ],
        },
      ]),
      [],
      { streaming: true },
    );
    const assistants = rows.filter((r) => r.kind === 'assistant') as Array<{ streaming: boolean }>;
    expect(assistants[0].streaming).toBe(false);
    expect(assistants[1].streaming).toBe(true);
  });

  it('no streaming caret when streaming=false', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{ type: 'assistant', text: 'x', toolName: null, toolInput: null, ts: T, elapsedMs: null }] }]),
      [],
      { streaming: false },
    );
    const a = rows.find((r) => r.kind === 'assistant') as { streaming: boolean };
    expect(a.streaming).toBe(false);
  });

  it('appends live-tail messages after the fetched transcript', () => {
    const live: LiveSessionMessage[] = [
      { sessionId: 's1', role: 'assistant', text: 'streamed reply', ts: T },
    ];
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{ type: 'user', text: 'q', toolName: null, toolInput: null, ts: T, elapsedMs: null }] }]),
      live,
      { streaming: true },
    );
    expect(rows.some((r) => r.kind === 'user' && r.text === 'q')).toBe(true);
    const a = rows.find((r) => r.kind === 'assistant') as { text: string; streaming: boolean };
    expect(a.text).toBe('streamed reply');
    expect(a.streaming).toBe(true);
  });

  it('de-duplicates a live message already present in the fetched transcript', () => {
    const msg = { type: 'assistant' as const, text: 'dup', toolName: null, toolInput: null, ts: T, elapsedMs: null };
    const live: LiveSessionMessage[] = [{ sessionId: 's1', role: 'assistant', text: 'dup', ts: T }];
    const rows = buildTranscriptRows(tx([{ turnIndex: 0, messages: [msg] }]), live);
    expect(rows.filter((r) => r.kind === 'assistant').length).toBe(1);
  });

  it('emits a fresh divider when the calendar day changes', () => {
    const rows = buildTranscriptRows(
      tx([
        { turnIndex: 0, messages: [{ type: 'user', text: 'day1', toolName: null, toolInput: null, ts: '2026-07-06T10:00:00.000Z', elapsedMs: null }] },
        { turnIndex: 1, messages: [{ type: 'user', text: 'day2', toolName: null, toolInput: null, ts: '2026-07-07T10:00:00.000Z', elapsedMs: 86400000 }] },
      ]),
      [],
    );
    expect(rows.filter((r) => r.kind === 'divider').length).toBe(2);
  });

  it('long real text passes through unmodified (ellipsis is a CSS concern)', () => {
    const long = 'exec_dispatch_mr9w9opu_uqdw '.repeat(20).trim();
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{ type: 'tool', text: null, toolName: 'read', toolInput: long, ts: T, elapsedMs: null }] }]),
      [],
    );
    const tools = rows.find((r) => r.kind === 'tools') as { calls: { input: string }[] };
    expect(tools.calls[0].input).toBe(long);
  });

  it('an optional formatDivider overrides the default divider label (mobile ZH dividers)', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{ type: 'user', text: 'hi', toolName: null, toolInput: null, ts: T, elapsedMs: null }] }]),
      [],
      { formatDivider: () => '今天 07:42' },
    );
    expect(rows[0]).toEqual({ kind: 'divider', text: '今天 07:42' });
  });

  it('without formatDivider the default EN divider is unchanged', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{ type: 'user', text: 'hi', toolName: null, toolInput: null, ts: T, elapsedMs: null }] }]),
      [],
    );
    expect((rows[0] as { text: string }).text.startsWith('TODAY') || (rows[0] as { text: string }).text.length > 0).toBe(true);
  });
});

describe('liveToMessage', () => {
  it('maps a tool live event to a tool TranscriptMessage (text null, tool fields set)', () => {
    const m = liveToMessage({ sessionId: 's1', role: 'tool', text: '', toolName: 'grep', toolInput: 'foo', ts: T });
    expect(m).toEqual({ type: 'tool', text: null, toolName: 'grep', toolInput: 'foo', ts: T, elapsedMs: null });
  });

  it('maps an assistant live event to an assistant TranscriptMessage', () => {
    const m = liveToMessage({ sessionId: 's1', role: 'assistant', text: 'hi', ts: T });
    expect(m).toEqual({ type: 'assistant', text: 'hi', toolName: null, toolInput: null, ts: T, elapsedMs: null });
  });
});

describe('currentTurnElapsedMs', () => {
  const mk = (ts: string, elapsedMs: number | null): SessionTranscript['turns'][number]['messages'][number] => ({
    type: 'assistant', text: 'x', toolName: null, toolInput: null, ts, elapsedMs,
  });

  it('sums only the LAST turn intra-turn deltas, excluding its opening message gap', () => {
    const t = tx([
      { turnIndex: 0, messages: [mk(T, null), mk(T, 2500)] },
      // Last turn: index 0 (7500) is the cross-turn idle gap → excluded; 1000 + 500 counted.
      { turnIndex: 1, messages: [mk(T, 7500), mk(T, 1000), mk(T, 500)] },
    ]);
    expect(currentTurnElapsedMs(t)).toBe(1500);
  });

  it('does not carry earlier turns into the current-turn clock', () => {
    const t = tx([
      { turnIndex: 0, messages: [mk(T, null), mk(T, 9999)] },
      { turnIndex: 1, messages: [mk(T, 3000), mk(T, 400)] },
    ]);
    expect(currentTurnElapsedMs(t)).toBe(400);
  });

  it('returns null when the last turn has no intra-turn signal (single message / all null)', () => {
    expect(currentTurnElapsedMs(tx([{ turnIndex: 0, messages: [mk(T, null)] }]))).toBeNull();
    expect(currentTurnElapsedMs(tx([{ turnIndex: 0, messages: [mk(T, 5000), mk(T, null)] }]))).toBeNull();
    expect(currentTurnElapsedMs(tx([]))).toBeNull();
    expect(currentTurnElapsedMs(undefined)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('formats ms into compact human-readable durations', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(2500)).toBe('2s');
    expect(formatElapsed(65000)).toBe('1m 5s');
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
    expect(formatElapsed(3_661_000)).toBe('1h 1m');
  });

  it('returns the em-dash placeholder for null (no fabrication)', () => {
    expect(formatElapsed(null)).toBe('—');
  });
});

describe('turnCount', () => {
  it('counts real turns', () => {
    expect(turnCount(tx([{ turnIndex: 0, messages: [] }, { turnIndex: 1, messages: [] }]))).toBe(2);
    expect(turnCount(undefined)).toBe(0);
  });
});

// snapshot + delta running resolution: the live `session.status` event (delta) wins once received;
// before any event, the authoritative sessions.list snapshot governs; the message-stream heuristic
// is the last resort (old servers with no `running` snapshot field).
describe('resolveRunning', () => {
  it('prefers the live status event over everything', () => {
    expect(resolveRunning(true, false, false)).toBe(true);
    expect(resolveRunning(false, true, true)).toBe(false);
  });

  it('falls back to the sessions.list snapshot before any status event', () => {
    expect(resolveRunning(null, true, false)).toBe(true);
    expect(resolveRunning(null, false, true)).toBe(false);
  });

  it('uses the stream heuristic only when neither event nor snapshot exists', () => {
    expect(resolveRunning(null, undefined, true)).toBe(true);
    expect(resolveRunning(null, undefined, false)).toBe(false);
  });
});

// Snapshot + delta background-hold resolution (fix: the Background state was delta-only and lost
// on session switch / reload / app restart — the sessions.list `backgroundRunning` snapshot now
// restores it, mirroring resolveRunning).
describe('resolveBackgroundRunning', () => {
  it('prefers the live status event over the snapshot', () => {
    expect(resolveBackgroundRunning(true, false)).toBe(true);
    expect(resolveBackgroundRunning(false, true)).toBe(false);
  });

  it('falls back to the sessions.list snapshot before any status event', () => {
    expect(resolveBackgroundRunning(null, true)).toBe(true);
    expect(resolveBackgroundRunning(null, false)).toBe(false);
  });

  it('is false when neither event nor snapshot exists (old servers)', () => {
    expect(resolveBackgroundRunning(null, undefined)).toBe(false);
  });
});

describe('resolveTurns', () => {
  it('prefers the live session.turn delta over the snapshot', () => {
    expect(resolveTurns(3, 8)).toBe(3);
    expect(resolveTurns(1, null)).toBe(1);
    expect(resolveTurns(0, 5)).toBe(0); // a real 0 delta still wins
  });

  it('falls back to the sessions.list numTurns snapshot before any delta', () => {
    expect(resolveTurns(null, 8)).toBe(8);
    expect(resolveTurns(null, 0)).toBe(0);
  });

  it('is null when neither a delta nor a snapshot exists', () => {
    expect(resolveTurns(null, null)).toBe(null);
    expect(resolveTurns(null, undefined)).toBe(null);
  });
});

describe('agent-sent file attachments (20a)', () => {
  const ATT = [{ name: 'r.pdf', path: 'workspace/outputs/s1/r.pdf', size: 2100, mimeType: 'application/pdf', type: 'file' as const }];

  it('carries attachments onto an assistant row', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        { type: 'user', text: 'send it', toolName: null, toolInput: null, ts: T, elapsedMs: null },
        { type: 'assistant', text: 'here', toolName: null, toolInput: null, ts: T, elapsedMs: 0, attachments: ATT },
      ] }]),
      [],
      { now: new Date(T) },
    );
    const assistant = rows.find((r) => r.kind === 'assistant') as { attachments?: unknown };
    expect(assistant.attachments).toEqual(ATT);
  });

  it('liveToMessage passes assistant attachments through the live tail', () => {
    const m = liveToMessage({ sessionId: 's1', role: 'assistant', text: '', ts: T, attachments: ATT } as LiveSessionMessage);
    expect(m.type).toBe('assistant');
    expect(m.attachments).toEqual(ATT);
  });
});

// ── Interaction entity rows (web-interactions-redesign) ─────────────────────

describe('interaction entity rows', () => {
  const detail = (status: 'pending' | 'approved') => ({
    id: 'req-1',
    kind: 'plan-approval' as const,
    status,
    payload: { planContent: '# P', planFilePath: null },
  });

  const mkTranscript = (status: 'pending' | 'approved'): SessionTranscript => ({
    sessionId: 's',
    turns: [{
      turnIndex: 0,
      messages: [
        { type: 'user', text: 'go', toolName: null, toolInput: null, ts: '2026-07-16T00:00:00.000Z', elapsedMs: null },
        { type: 'interaction', text: 'Plan', toolName: null, toolInput: null, ts: '2026-07-16T00:00:01.000Z', elapsedMs: null, subtype: `plan-${status}`, interaction: detail(status) as any },
      ],
    }],
  });

  it('carries the structured detail through to the interaction row', () => {
    const rows = buildTranscriptRows(mkTranscript('pending'), []);
    const row = rows.find((r) => r.kind === 'interaction');
    expect(row && row.kind === 'interaction' && row.detail?.id).toBe('req-1');
    expect(row && row.kind === 'interaction' && row.detail?.status).toBe('pending');
  });

  it('carries the row ts through (TTL countdown + HH:MM badges need it)', () => {
    const rows = buildTranscriptRows(mkTranscript('pending'), []);
    const row = rows.find((r) => r.kind === 'interaction');
    expect(row && row.kind === 'interaction' && row.ts).toBe('2026-07-16T00:00:01.000Z');
  });

  it('keys interaction rows by entity id so a status change replaces (never duplicates)', () => {
    // Same interaction appearing twice with different status/ts (e.g. transcript refetch race)
    // must collapse to ONE row with the first occurrence winning within a single build.
    const t = mkTranscript('approved');
    t.turns[0].messages.push({
      type: 'interaction', text: 'Plan approved', toolName: null, toolInput: null,
      ts: '2026-07-16T00:00:02.000Z', elapsedMs: null, subtype: 'plan-approved', interaction: detail('approved') as any,
    });
    const rows = buildTranscriptRows(t, []);
    expect(rows.filter((r) => r.kind === 'interaction').length).toBe(1);
  });
});

describe('message edit + rewind (desktop 23 / mobile 7)', () => {
  const twoTurns = tx([
    {
      turnIndex: 0,
      messages: [
        { type: 'user', text: 'first', toolName: null, toolInput: null, ts: T, elapsedMs: null },
        { type: 'assistant', text: 'r0', toolName: null, toolInput: null, ts: T, elapsedMs: 100 },
      ],
    },
    {
      turnIndex: 1,
      messages: [
        { type: 'user', text: 'second', toolName: null, toolInput: null, ts: T, elapsedMs: 100, edited: { originalText: 'second-orig', originalTs: T } } as never,
        { type: 'tool', text: null, toolName: 'Read', toolInput: 'x.ts', ts: T, elapsedMs: 100 },
        { type: 'tool', text: null, toolName: 'Bash', toolInput: 'ls', ts: T, elapsedMs: 100 },
        { type: 'assistant', text: 'r1', toolName: null, toolInput: null, ts: T, elapsedMs: 100 },
        { type: 'assistant', text: 'r2', toolName: null, toolInput: null, ts: T, elapsedMs: 100 },
      ],
    },
  ]);

  it('user rows carry their turnIndex (the rewind anchor)', () => {
    const rows = buildTranscriptRows(twoTurns, []);
    const users = rows.filter((r) => r.kind === 'user') as { turnIndex?: number }[];
    expect(users.map((u) => u.turnIndex)).toEqual([0, 1]);
  });

  it('user rows carry the edited marker (已编辑 badge + original card)', () => {
    const rows = buildTranscriptRows(twoTurns, []);
    const users = rows.filter((r) => r.kind === 'user') as { edited?: unknown }[];
    expect(users[0].edited).toBeUndefined();
    expect(users[1].edited).toEqual({ originalText: 'second-orig', originalTs: T });
  });

  it('live-tail user rows have no turnIndex (not editable until the transcript reconciles)', () => {
    const live: LiveSessionMessage[] = [{ sessionId: 's1', role: 'user', text: 'fresh', ts: '2026-07-07T07:43:00.000Z' }];
    const rows = buildTranscriptRows(tx([]), live);
    const user = rows.find((r) => r.kind === 'user') as { turnIndex?: number };
    expect(user.turnIndex).toBeUndefined();
  });

  it('rewindStats counts replies + tool calls after the edited user row', () => {
    const rows = buildTranscriptRows(twoTurns, []);
    const idx1 = rows.findIndex((r) => r.kind === 'user' && (r as { turnIndex?: number }).turnIndex === 1);
    expect(rewindStats(rows, idx1)).toEqual({ replies: 2, toolCalls: 2 });
    const idx0 = rows.findIndex((r) => r.kind === 'user' && (r as { turnIndex?: number }).turnIndex === 0);
    expect(rewindStats(rows, idx0)).toEqual({ replies: 3, toolCalls: 2 });
  });

  it('rewindStats on the last row → zeros', () => {
    const rows = buildTranscriptRows(twoTurns, []);
    expect(rewindStats(rows, rows.length - 1)).toEqual({ replies: 0, toolCalls: 0 });
  });
});

// ── Token-level streaming ────────────────────────────────────────────────────────────────────

describe('applyAssistantDelta — accumulating a block still being written', () => {
  const delta = (blockId: string, text: string, seq = 0) => ({ blockId, text, seq });

  it('starts a block from nothing', () => {
    expect(applyAssistantDelta(null, delta('msg_A:1', 'Tea '))).toEqual({ blockId: 'msg_A:1', text: 'Tea ' });
  });

  it('appends chunks of the same block in arrival order', () => {
    let s: StreamingBlock | null = null;
    s = applyAssistantDelta(s, delta('msg_A:1', 'Tea ', 0));
    s = applyAssistantDelta(s, delta('msg_A:1', 'begins ', 1));
    s = applyAssistantDelta(s, delta('msg_A:1', 'as a leaf.', 2));
    expect(s).toEqual({ blockId: 'msg_A:1', text: 'Tea begins as a leaf.' });
  });

  it('a new blockId replaces the previous block rather than concatenating across blocks', () => {
    const prev: StreamingBlock = { blockId: 'msg_A:1', text: 'first block' };
    expect(applyAssistantDelta(prev, delta('msg_A:3', 'second'))).toEqual({ blockId: 'msg_A:3', text: 'second' });
  });

  it('ignores malformed events instead of rendering a blank bubble', () => {
    const prev: StreamingBlock = { blockId: 'msg_A:1', text: 'kept' };
    expect(applyAssistantDelta(prev, { text: 'no id' } as never)).toBe(prev);
    expect(applyAssistantDelta(prev, { blockId: 'msg_A:1' } as never)).toBe(prev);
    expect(applyAssistantDelta(null, {} as never)).toBe(null);
  });
});

describe('endStreamingBlock — the authoritative message takes over', () => {
  const streaming: StreamingBlock = { blockId: 'msg_A:1', text: 'partial te' };

  it('clears the preview when the complete message of the SAME block arrives', () => {
    expect(endStreamingBlock(streaming, 'msg_A:1')).toBe(null);
  });

  it('clears it for a message carrying no blockId — never leave a ghost preview behind', () => {
    expect(endStreamingBlock(streaming, undefined)).toBe(null);
  });

  it('keeps a preview whose own block has not finalized yet', () => {
    expect(endStreamingBlock(streaming, 'msg_A:0')).toBe(streaming);
  });

  it('is a no-op when nothing is streaming', () => {
    expect(endStreamingBlock(null, 'msg_A:1')).toBe(null);
  });
});

describe('buildTranscriptRows — the live streaming row', () => {
  const oneTurn = tx([
    {
      turnIndex: 0,
      messages: [{ type: 'user', text: 'about tea?', toolName: null, toolInput: null, ts: T, elapsedMs: null }],
    },
  ]);

  it('appends the accumulating text as a streaming assistant row', () => {
    const rows = buildTranscriptRows(oneTurn, [], { streamingText: 'Tea begins as a' });
    const last = rows[rows.length - 1];
    expect(last).toEqual({ kind: 'assistant', text: 'Tea begins as a', streaming: true });
  });

  it('adds no row when nothing is streaming', () => {
    const rows = buildTranscriptRows(oneTurn, []);
    expect(rows.some((r) => r.kind === 'assistant')).toBe(false);
  });

  it('adds no row for an empty accumulation (no blank bubble before the first chunk)', () => {
    const rows = buildTranscriptRows(oneTurn, [], { streamingText: '' });
    expect(rows.some((r) => r.kind === 'assistant')).toBe(false);
  });

  it('the complete message replaces the preview — one assistant row, not two', () => {
    // What the hook produces at handover: the message is in the live tail and streamingText is null.
    const tail: LiveSessionMessage[] = [
      { sessionId: 's1', role: 'assistant', text: 'Tea begins as a leaf.', ts: T, blockId: 'msg_A:1' },
    ];
    const rows = buildTranscriptRows(oneTurn, tail, { streamingText: null });
    const assistants = rows.filter((r) => r.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual({ kind: 'assistant', text: 'Tea begins as a leaf.', streaming: false });
  });

  it('the streaming row sits last, after any tool calls of the same turn', () => {
    const tail: LiveSessionMessage[] = [
      { sessionId: 's1', role: 'tool', text: '', toolName: 'Read', toolInput: 'a.ts', ts: T },
    ];
    const rows = buildTranscriptRows(oneTurn, tail, { streamingText: 'now answering' });
    expect(rows[rows.length - 2].kind).toBe('tools');
    expect(rows[rows.length - 1]).toEqual({ kind: 'assistant', text: 'now answering', streaming: true });
  });
});
