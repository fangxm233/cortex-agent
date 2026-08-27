// input:  transcript helpers, DEBUG warnings, notices, pending fixtures
// output: spawn prompt, grouping, streaming, and pending regressions
// pos:    Workbench transcript view-model specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  buildTranscriptRows,
  liveToMessage,
  turnCount,
  currentTurnElapsedMs,
  resolveRunning,
  resolveBackgroundRunning,
  resolveTurns,
  rewindStats,
  assistantTurnCopyTargets,
  applyAssistantDelta,
  endStreamingBlock,
  initialAssistantPreviewState,
  applyAssistantPreviewDelta,
  finalizeAssistantPreview,
  applyDelivered,
  reconcilePendingUserMessages,
  subagentModelLabel,
  type ChatRow,
  type LiveSessionMessage,
  type PendingUserMessage,
  type StreamingBlock,
} from './transcript-vm';
import type { SessionTranscript } from '@cortex-agent/ui-contract';

const T = '2026-07-07T07:42:00.000Z';

function tx(turns: SessionTranscript['turns']): SessionTranscript {
  return { sessionId: 's1', turns };
}

describe('assistantTurnCopyTargets', () => {
  it('places one combined copy target after the final assistant or trailing tools', () => {
    const rows: ChatRow[] = [
      { kind: 'user', text: 'first' },
      { kind: 'assistant', text: 'part one', streaming: false },
      { kind: 'tools', count: 1, calls: [{ kind: 'read', input: 'a.md' }] },
      { kind: 'assistant', text: 'part two', streaming: false },
      { kind: 'tools', count: 1, calls: [{ kind: 'bash', input: 'pwd' }] },
      { kind: 'user', text: 'second' },
      { kind: 'notice', level: 'info', text: 'notice' },
      { kind: 'assistant', text: 'next turn', streaming: false },
    ];

    expect([...assistantTurnCopyTargets(rows)]).toEqual([
      [4, 'part one\n\npart two'],
      [7, 'next turn'],
    ]);
  });

  it('moves the target past trailing subagents and interaction content', () => {
    const rows: ChatRow[] = [
      { kind: 'user', text: 'question' },
      { kind: 'assistant', text: 'main answer', streaming: false },
      {
        kind: 'subagent', id: 'tu_a', agentType: 'explore', description: 'inspect',
        prompt: 'inspect', model: 'model-x', status: 'done', toolCount: 1,
        children: [{ kind: 'assistant', text: 'child detail', streaming: false }],
      },
      { kind: 'interaction', subtype: 'plan', text: 'approval requested' },
    ];

    expect([...assistantTurnCopyTargets(rows)]).toEqual([[3, 'main answer']]);
  });

  it('ignores empty assistant text and turns without assistant text', () => {
    const rows: ChatRow[] = [
      { kind: 'assistant', text: '', streaming: false },
      { kind: 'user', text: 'question' },
      { kind: 'interaction', subtype: 'ask-user', text: 'answer me' },
    ];

    expect([...assistantTurnCopyTargets(rows)]).toEqual([]);
  });
});

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

  it('maps fetched and live assistant notices to notice rows', () => {
    const fetched = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{
        type: 'assistant',
        text: 'Context auto-compacted.',
        toolName: null,
        toolInput: null,
        noticeLevel: 'info',
        ts: T,
        elapsedMs: null,
      }] }]),
      [],
    );
    const authAction = {
      kind: 'auth-login' as const, noticeId: 'notice-web',
      backend: 'pi' as const, provider: 'deepseek', authType: 'api_key' as const,
    };
    const live = buildTranscriptRows(
      tx([]),
      [{
        sessionId: 's1', role: 'assistant', text: 'Heads up', noticeLevel: 'warning',
        authAction, ts: T,
      }],
    );

    expect(fetched[1]).toEqual({ kind: 'notice', level: 'info', text: 'Context auto-compacted.' });
    expect(live[1]).toEqual({
      kind: 'notice', level: 'warning', text: 'Heads up', authAction,
    });
    expect(fetched.some((row) => row.kind === 'assistant')).toBe(false);
  });

  it('carries a notice action onto the row from both the snapshot and the live tail', () => {
    const noticeAction = { kind: 'cancel-resume' as const };
    const fetched = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{
        type: 'assistant',
        text: 'Rate limited',
        toolName: null,
        toolInput: null,
        noticeLevel: 'warning',
        noticeAction,
        ts: T,
        elapsedMs: null,
      }] }]),
      [],
    );
    const live = buildTranscriptRows(
      tx([]),
      [{ sessionId: 's1', role: 'assistant', text: 'Rate limited', noticeLevel: 'warning', noticeAction, ts: T }],
    );

    expect(fetched[1]).toEqual({ kind: 'notice', level: 'warning', text: 'Rate limited', noticeAction });
    expect(live[1]).toEqual({ kind: 'notice', level: 'warning', text: 'Rate limited', noticeAction });
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

  it('preserves DEBUG agent messages and complete per-tool input/results on their rows', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        { type: 'user', text: 'visible', toolName: null, toolInput: null, ts: T, elapsedMs: null, debug: { agentMessage: 'context\nvisible' } } as any,
        { type: 'tool', text: null, toolName: 'Bash', toolInput: 'echo …', ts: T, elapsedMs: 0, debug: { toolInput: { command: 'echo full', timeout: 120000 }, toolResult: { content: 'line 1\nline 2', isError: false }, overCharacterThreshold: true } } as any,
      ] }]),
      [],
    );

    expect(rows[1]).toMatchObject({ kind: 'user', debug: { agentMessage: 'context\nvisible' } });
    expect(rows[2]).toEqual({
      kind: 'tools',
      count: 1,
      calls: [{
        kind: 'Bash',
        input: 'echo …',
        debug: { toolInput: { command: 'echo full', timeout: 120000 }, toolResult: { content: 'line 1\nline 2', isError: false }, overCharacterThreshold: true },
      }],
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

  it('preserves notice level on an assistant live event', () => {
    const m = liveToMessage({
      sessionId: 's1', role: 'assistant', text: 'Heads up', noticeLevel: 'error', ts: T,
    });
    expect(m.noticeLevel).toBe('error');
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

describe('assistant preview handoff — final messages seal their block', () => {
  const delta = (blockId: string, text: string, seq = 0) => ({ blockId, text, seq });

  it('does not recreate a preview when the final message arrives before a late delta', () => {
    let state = initialAssistantPreviewState();
    state = applyAssistantPreviewDelta(state, delta('msg_A:1', 'Tea begins ', 0));
    state = finalizeAssistantPreview(state, 'msg_A:1');
    state = applyAssistantPreviewDelta(state, delta('msg_A:1', 'as a leaf.', 1));

    expect(state.active).toBeNull();
    expect(state.finalizedBlockIds).toContain('msg_A:1');
  });

  it('ignores a late delta even when this client saw the final before any preview chunk', () => {
    let state = finalizeAssistantPreview(initialAssistantPreviewState(), 'msg_A:1');
    state = applyAssistantPreviewDelta(state, delta('msg_A:1', 'last fragment', 4));
    expect(state.active).toBeNull();
  });

  it('still starts the next distinct assistant block', () => {
    let state = finalizeAssistantPreview(initialAssistantPreviewState(), 'msg_A:1');
    state = applyAssistantPreviewDelta(state, delta('msg_A:2', 'A new block', 0));
    expect(state.active).toEqual({ blockId: 'msg_A:2', text: 'A new block' });
  });

  it('produces one assistant row for the reported cross-SSE arrival order', () => {
    const tail: LiveSessionMessage[] = [
      { sessionId: 's1', role: 'assistant', text: 'Tea begins as a leaf.', ts: T, blockId: 'msg_A:1' },
    ];
    let state = finalizeAssistantPreview(initialAssistantPreviewState(), 'msg_A:1');
    state = applyAssistantPreviewDelta(state, delta('msg_A:1', 'as a leaf.', 1));
    const rows = buildTranscriptRows(tx([]), tail, { streamingText: state.active?.text ?? null });

    expect(rows.filter((row) => row.kind === 'assistant')).toHaveLength(1);
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
    expect(last).toEqual({ kind: 'assistant', text: 'Tea begins as a', streaming: true, preview: true });
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
    expect(rows[rows.length - 1]).toEqual({ kind: 'assistant', text: 'now answering', streaming: true, preview: true });
  });
});

// ── `preview` — which row is the not-yet-authoritative one ──────────────────────────────────────
//
// The smooth reveal paces ONLY the live preview, so the row model has to say which row that is.
// `streaming` cannot answer it: the idle heuristic also flags the last COMPLETE assistant row for a
// few seconds after the last event, and pacing an already-final message would re-type text the user
// has read and leave an animation running after the turn went idle.

describe('buildTranscriptRows — preview marks only the in-flight block', () => {
  const oneTurn = tx([
    {
      turnIndex: 0,
      messages: [{ type: 'user', text: 'about tea?', toolName: null, toolInput: null, ts: T, elapsedMs: null }],
    },
  ]);

  it('marks the accumulating block as the preview', () => {
    const rows = buildTranscriptRows(oneTurn, [], { streamingText: 'Tea begins as a' });
    const last = rows[rows.length - 1] as { kind: string; preview?: boolean };
    expect(last.preview).toBe(true);
  });

  it('never marks a persisted assistant row as the preview', () => {
    const persisted = tx([
      {
        turnIndex: 0,
        messages: [
          { type: 'user', text: 'about tea?', toolName: null, toolInput: null, ts: T, elapsedMs: null },
          { type: 'assistant', text: 'Tea begins as a leaf.', toolName: null, toolInput: null, ts: T, elapsedMs: null },
        ],
      },
    ]);
    const rows = buildTranscriptRows(persisted, [], {});
    const assistants = rows.filter((r) => r.kind === 'assistant') as { preview?: boolean }[];
    expect(assistants.every((a) => !a.preview)).toBe(true);
  });

  it('never marks the authoritative message as the preview while the idle heuristic still says streaming', () => {
    // The handover instant: the complete message is in the live tail, the preview is retired, but
    // `streaming` stays true until the quiet gap elapses. That row must settle, not animate.
    const tail: LiveSessionMessage[] = [
      { sessionId: 's1', role: 'assistant', text: 'Tea begins as a leaf.', ts: T, blockId: 'msg_A:1' },
    ];
    const rows = buildTranscriptRows(oneTurn, tail, { streaming: true, streamingText: null });
    const assistants = rows.filter((r) => r.kind === 'assistant') as { streaming: boolean; preview?: boolean }[];
    expect(assistants).toHaveLength(1);
    expect(assistants[0].streaming).toBe(true);
    expect(assistants[0].preview).toBeUndefined();
  });
});

// ── A message the model has not read yet ────────────────────────────────────────────────────────
//
// Sending while a turn is running writes the message into the backend's stdin, which only QUEUES it
// there — the model may not read it for seconds, or until after the current turn's result. Until it
// does, the message is not part of the conversation and everything the agent is saying was said
// without it, so it is held out of the ordered stream and shown as a provisional row at the bottom.

describe('applyDelivered — a pending message entering the stream', () => {
  const pending: PendingUserMessage[] = [
    { ts: 'T-write-1', text: 'skip the rest' },
    { ts: 'T-write-2', text: 'and one more' },
  ];

  it('re-keys the acked message to the committed ts and hands it to the tail', () => {
    const out = applyDelivered(pending, { messageTs: 'T-write-1', committedTs: 'T-read-1' });
    expect(out.committed).toEqual({ sessionId: '', role: 'user', text: 'skip the rest', ts: 'T-read-1', attachments: undefined });
    expect(out.pending).toEqual([{ ts: 'T-write-2', text: 'and one more' }]);
  });

  it('carries the attachments across', () => {
    const att = [{ name: 'a.png', path: 'workspace/attachments/a.png', size: 3, mimeType: 'image/png', type: 'image' as const }];
    const out = applyDelivered([{ ts: 'T1', text: 'look', attachments: att }], { messageTs: 'T1', committedTs: 'T2' });
    expect(out.committed?.attachments).toEqual(att);
  });

  it('ignores an ack for a message it is not holding', () => {
    const out = applyDelivered(pending, { messageTs: 'T-unknown', committedTs: 'T-read' });
    expect(out.committed).toBe(null);
    expect(out.pending).toBe(pending);
  });

  it('falls back to the pending key when the server sent no committed ts', () => {
    const out = applyDelivered(pending, { messageTs: 'T-write-1' });
    expect(out.committed?.ts).toBe('T-write-1');
  });

  it('leaves the other pending messages in send order', () => {
    const out = applyDelivered(pending, { messageTs: 'T-write-1', committedTs: 'T-read-1' });
    const out2 = applyDelivered(out.pending, { messageTs: 'T-write-2', committedTs: 'T-read-2' });
    expect(out2.pending).toEqual([]);
    expect(out2.committed?.ts).toBe('T-read-2');
  });

  it('uses stable pendingId before the legacy timestamp key, so identical timestamps stay independent', () => {
    const sameTs: PendingUserMessage[] = [
      { id: 'pin-1', ts: 'T-write', text: 'same' },
      { id: 'pin-2', ts: 'T-write', text: 'same' },
    ];
    const out = applyDelivered(sameTs, { pendingId: 'pin-2', messageTs: 'T-write', committedTs: 'T-read' });
    expect(out.pending).toEqual([{ id: 'pin-1', ts: 'T-write', text: 'same' }]);
    expect(out.committed?.ts).toBe('T-read');
  });
});

describe('reconcilePendingUserMessages — a lost ack must not strand a dimmed row', () => {
  const pending: PendingUserMessage[] = [{ ts: '2026-07-07T07:42:00.000Z', text: 'skip the rest' }];
  const withRecord = (ts: string, text: string): SessionTranscript =>
    tx([{ turnIndex: 0, messages: [{ type: 'user', text, toolName: null, toolInput: null, ts, elapsedMs: null }] }]);

  it('drops a pending message the refetched transcript already contains', () => {
    expect(reconcilePendingUserMessages(pending, withRecord('2026-07-07T07:42:06.000Z', 'skip the rest'))).toEqual([]);
  });

  it('keeps one the transcript does not have yet', () => {
    expect(reconcilePendingUserMessages(pending, withRecord('2026-07-07T07:42:06.000Z', 'something else'))).toBe(pending);
  });

  it('keeps it when the only matching record predates the send — that is an older, identical message', () => {
    expect(reconcilePendingUserMessages(pending, withRecord('2026-07-07T07:00:00.000Z', 'skip the rest'))).toBe(pending);
  });

  it('two identical sends need two records before both clear', () => {
    const twice: PendingUserMessage[] = [
      { ts: '2026-07-07T07:42:00.000Z', text: 'stop' },
      { ts: '2026-07-07T07:42:01.000Z', text: 'stop' },
    ];
    const one = reconcilePendingUserMessages(twice, withRecord('2026-07-07T07:42:06.000Z', 'stop'));
    expect(one).toHaveLength(1);
    expect(one[0].ts).toBe('2026-07-07T07:42:01.000Z');
  });

  it('returns the same list when nothing changed, so a refetch cannot loop the state', () => {
    expect(reconcilePendingUserMessages(pending, tx([]))).toBe(pending);
    expect(reconcilePendingUserMessages(pending, undefined)).toBe(pending);
    const empty: PendingUserMessage[] = [];
    expect(reconcilePendingUserMessages(empty, withRecord('2026-07-07T07:42:06.000Z', 'x'))).toBe(empty);
  });

  it('rehydrates pending rows from the authoritative transcript snapshot after reload/device switch', () => {
    const snapshot = {
      sessionId: 's1',
      turns: [],
      pendingUserMessages: [
        { id: 'pin-1', text: 'change direction', ts: '2026-07-07T08:00:00.000Z' },
        { id: 'pin-2', text: 'same text', ts: '2026-07-07T08:00:01.000Z' },
      ],
    } as any;
    expect(reconcilePendingUserMessages([], snapshot)).toEqual(snapshot.pendingUserMessages);
  });

  it('treats an explicit empty pending snapshot as authoritative after another device commits', () => {
    const local: PendingUserMessage[] = [{ id: 'pin-1', ts: '2026-07-07T08:00:00.000Z', text: 'change direction' }];
    const snapshot = { sessionId: 's1', turns: [], pendingUserMessages: [] } as any;
    expect(reconcilePendingUserMessages(local, snapshot)).toEqual([]);
  });

  it('does not resurrect a delivered id from a stale pending snapshot response', () => {
    const stale = {
      sessionId: 's1', turns: [],
      pendingUserMessages: [{ id: 'pin-1', text: 'change direction', ts: '2026-07-07T08:00:00.000Z' }],
    } as any;
    expect(reconcilePendingUserMessages([], stale, new Set(['pin-1']))).toEqual([]);
  });
});

describe('buildTranscriptRows — pending user rows are pinned to the bottom', () => {
  const oneTurn = tx([
    { turnIndex: 0, messages: [{ type: 'user', text: 'write the essay', toolName: null, toolInput: null, ts: T, elapsedMs: null }] },
  ]);

  it('renders below the live streaming preview — the agent has not read it yet', () => {
    const rows = buildTranscriptRows(oneTurn, [], {
      streamingText: 'A bicycle is',
      pendingUser: [{ ts: 'T-write', text: 'stop and say TEXT-INTERRUPTED' }],
    });
    expect(rows[rows.length - 2]).toEqual({ kind: 'assistant', text: 'A bicycle is', streaming: true, preview: true });
    expect(rows[rows.length - 1]).toEqual({ kind: 'user', text: 'stop and say TEXT-INTERRUPTED', pending: true, attachments: undefined, ts: 'T-write' });
  });

  it('keeps two pending messages in send order among themselves', () => {
    const rows = buildTranscriptRows(oneTurn, [], {
      pendingUser: [{ ts: 'T1', text: 'first' }, { ts: 'T2', text: 'second' }],
    });
    expect(rows.slice(-2).map((r) => (r.kind === 'user' ? r.text : r.kind))).toEqual(['first', 'second']);
  });

  it('carries attachments and never a turnIndex — a pending row is not editable', () => {
    const att = [{ name: 'a.png', path: 'workspace/attachments/a.png', size: 3, mimeType: 'image/png', type: 'image' as const }];
    const rows = buildTranscriptRows(oneTurn, [], { pendingUser: [{ ts: 'T1', text: 'look', attachments: att }] });
    const last = rows[rows.length - 1];
    expect(last.kind === 'user' && last.attachments).toEqual(att);
    expect(last.kind === 'user' && last.turnIndex).toBeUndefined();
  });

  it('adds no rows when nothing is pending', () => {
    expect(buildTranscriptRows(oneTurn, [], { pendingUser: [] })).toEqual(buildTranscriptRows(oneTurn, []));
  });

  it('once committed, the message is an ordinary row above later output', () => {
    // What the hook produces at handover: out of `pendingUser`, into the tail under committedTs.
    const tail: LiveSessionMessage[] = [
      { sessionId: 's1', role: 'user', text: 'stop', ts: '2026-07-07T07:42:06.000Z' },
      { sessionId: 's1', role: 'assistant', text: 'TEXT-INTERRUPTED', ts: '2026-07-07T07:42:07.000Z' },
    ];
    const rows = buildTranscriptRows(oneTurn, tail, { pendingUser: [] });
    expect(rows.slice(-2)).toEqual([
      { kind: 'user', text: 'stop', attachments: undefined, ts: '2026-07-07T07:42:06.000Z' },
      { kind: 'assistant', text: 'TEXT-INTERRUPTED', streaming: false, attachments: undefined },
    ]);
  });
});

// ── scheduled-run opening prompt (design 30c: the task prompt is a PLAIN user bubble) ──

describe('buildTranscriptRows stripScheduledPrefix', () => {
  const schedTx = () => tx([
    {
      turnIndex: 0,
      messages: [
        { type: 'user', text: '[Scheduled Task] Scan arXiv for new papers', toolName: null, toolInput: null, ts: T, elapsedMs: null },
        { type: 'assistant', text: 'found 3', toolName: null, toolInput: null, ts: T, elapsedMs: 1000 },
      ],
    },
    {
      turnIndex: 1,
      messages: [
        { type: 'user', text: 'follow up please', toolName: null, toolInput: null, ts: T, elapsedMs: null },
      ],
    },
  ]);

  it('strips the [Scheduled Task] prefix off the first user row but keeps it a user bubble', () => {
    const rows = buildTranscriptRows(schedTx(), [], { stripScheduledPrefix: true });
    expect(rows[1]).toEqual({ kind: 'user', text: 'Scan arXiv for new papers', turnIndex: 0, ts: T });
    expect(rows.filter((r) => r.kind === 'user').map((r) => (r as any).text))
      .toEqual(['Scan arXiv for new papers', 'follow up please']);
  });

  it('does nothing without the option (manual sessions keep the raw text)', () => {
    const rows = buildTranscriptRows(schedTx(), []);
    expect(rows[1]).toEqual(expect.objectContaining({ kind: 'user', text: '[Scheduled Task] Scan arXiv for new papers' }));
  });

  it('leaves a first user row without the prefix untouched', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [{ type: 'user', text: 'plain start', toolName: null, toolInput: null, ts: T, elapsedMs: null }] }]),
      [],
      { stripScheduledPrefix: true },
    );
    expect(rows[1]).toEqual({ kind: 'user', text: 'plain start', turnIndex: 0, ts: T });
  });

  it('never strips the prefix off a later user row (only the opening prompt is the fire payload)', () => {
    const rows = buildTranscriptRows(
      tx([
        { turnIndex: 0, messages: [{ type: 'user', text: 'plain start', toolName: null, toolInput: null, ts: T, elapsedMs: null }] },
        { turnIndex: 1, messages: [{ type: 'user', text: '[Scheduled Task] quoted later', toolName: null, toolInput: null, ts: T, elapsedMs: null }] },
      ]),
      [],
      { stripScheduledPrefix: true },
    );
    expect(rows.filter((r) => r.kind === 'user').map((r) => (r as any).text))
      .toEqual(['plain start', '[Scheduled Task] quoted later']);
  });
});

describe('buildTranscriptRows — native subagent grouping', () => {
  const msg = (o: Partial<Parameters<typeof buildTranscriptRows>[0]['turns'][0]['messages'][0]> & { type: 'user' | 'assistant' | 'tool' }) =>
    ({ text: null, toolName: null, toolInput: null, ts: T, elapsedMs: null, ...o }) as any;

  it('builds one card per structured spawn and preserves complete multiline prompts', () => {
    const first = 'Inspect desktop.\n\n' + 'A'.repeat(180);
    const second = 'Inspect mobile.\nKeep formatting.';
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'user', text: 'go' }),
        msg({
          type: 'tool', toolName: 'agent', toolInput: '[batch]',
          subagentSpawns: [
            { id: 'tu_batch#0', type: 'explore', description: 'desktop', prompt: first },
            { id: 'tu_batch#1', type: 'reviewer', description: 'mobile', prompt: second },
          ],
        } as any),
        msg({ type: 'assistant', text: 'desktop notes', subagentId: 'tu_batch#0', subagentDescription: 'desktop exact' }),
        msg({ type: 'assistant', text: 'mobile notes', subagentId: 'tu_batch#1' }),
      ] }]),
      [],
    );

    const blocks = rows.filter((row) => row.kind === 'subagent') as Array<Extract<ChatRow, { kind: 'subagent' }>>;
    expect(blocks.map((block) => block.id)).toEqual(['tu_batch#0', 'tu_batch#1']);
    expect(blocks.map((block) => block.prompt)).toEqual([first, second]);
    expect(blocks[0].description).toBe('desktop exact');
    expect(rows.some((row) => row.kind === 'tools')).toBe(false);
  });

  it('uses a chain child runtime prompt without dropping the same child row', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({
          type: 'assistant', text: 'chain child notes', subagentId: 'tu_chain#1',
          subagentDescription: 'second child',
          subagentSpawns: [{
            id: 'tu_chain#1', type: 'explore', description: 'second child',
            prompt: 'Use the actual previous result now',
          }],
        } as any),
      ] }]),
      [],
    );
    const block = rows.find((row) => row.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>;
    expect(block.prompt).toBe('Use the actual previous result now');
    expect(block.children).toMatchObject([{ kind: 'assistant', text: 'chain child notes' }]);
  });

  it('keeps a subagent tool run merged across a calendar-day boundary', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({
          type: 'tool', toolName: 'agent', toolInput: 'survey', ts: '2026-07-06T09:00:00.000Z',
          subagentSpawns: [{ id: 'tu_day', type: 'explore', description: 'survey', prompt: 'survey' }],
        } as any),
        msg({ type: 'tool', toolName: 'Read', toolInput: 'a.ts', subagentId: 'tu_day', ts: '2026-07-06T10:00:00.000Z' }),
        msg({ type: 'tool', toolName: 'Bash', toolInput: 'test', subagentId: 'tu_day', ts: '2026-07-07T10:00:00.000Z' }),
      ] }]),
      [],
    );
    const block = rows.find((row) => row.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>;
    expect(block.children).toHaveLength(1);
    expect(block.children[0]).toMatchObject({
      kind: 'tools',
      count: 2,
      calls: [{ kind: 'Read', input: 'a.ts' }, { kind: 'Bash', input: 'test' }],
    });
  });

  it('takes the model from the first subagent row that reports one, not from the anchor', () => {
    // The CLI ships no `subagent_model`; the model is `message.model` off the subagent's own
    // messages, so the spawning call — which happens before the subagent has answered — cannot
    // know it. It must fill in later, exactly like agentType and description do.
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'user', text: 'go' }),
        msg({ type: 'tool', toolName: 'Task', toolInput: 'survey', subagentId: 'tu_m' }),
        msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'tu_m', subagentType: 'explore', subagentModel: 'claude-haiku-4-5-20260101' }),
        msg({ type: 'assistant', text: 'notes', subagentId: 'tu_m', subagentModel: 'claude-sonnet-4-6' }),
      ] }]),
      [],
    );
    const block = rows.find((r) => r.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>;
    // First reporter wins — a later row must not relabel work already attributed.
    expect(block.model).toBe('claude-haiku-4-5-20260101');
  });

  it('leaves the model null while only the anchor is known', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'tool', toolName: 'Task', toolInput: 'survey', subagentId: 'tu_n' }),
      ] }]),
      [],
    );
    const block = rows.find((r) => r.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>;
    expect(block.model).toBeNull();
  });

  it('keeps the block running through a quiet gap that clears the streaming flag', () => {
    // `streaming` is a 2.5s quiet-gap timer, so it drops between events INSIDE a live turn. Deriving
    // the block's state from it made the badge blink on and off for the whole run; `running` is the
    // session's real execution state and does not flicker.
    const turns = [{ turnIndex: 0, messages: [
      msg({ type: 'user', text: 'go' }),
      msg({ type: 'tool', toolName: 'Task', toolInput: 'survey', subagentId: 'tu_q' }),
      msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'tu_q' }),
    ] }];
    const quiet = buildTranscriptRows(tx(turns), [], { streaming: false, running: true });
    expect((quiet.find((r) => r.kind === 'subagent') as any).status).toBe('running');

    // Once the session is no longer executing the block settles, regardless of the timer.
    const settled = buildTranscriptRows(tx(turns), [], { streaming: true, running: false });
    expect((settled.find((r) => r.kind === 'subagent') as any).status).toBe('done');
  });

  it('keeps a backgrounded subagent running while the main agent works alongside it', () => {
    // `run_in_background` lets the main agent keep calling tools while the subagent runs, so its
    // rows interleave. The block must reopen rather than freeze at 'done' or split in two.
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'user', text: 'go' }),
        msg({ type: 'tool', toolName: 'Task', toolInput: 'survey', subagentId: 'tu_bg' }),
        msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'tu_bg' }),
        msg({ type: 'tool', toolName: 'Bash', toolInput: 'main-agent work' }),
        msg({ type: 'tool', toolName: 'Read', toolInput: 'y', subagentId: 'tu_bg' }),
      ] }]),
      [],
      { running: true },
    );
    const blocks = rows.filter((r) => r.kind === 'subagent') as Array<Extract<ChatRow, { kind: 'subagent' }>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe('running');
    expect(blocks[0].toolCount).toBe(2);
  });

  it('folds a subagent\'s work into a block anchored at the spawning call', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'user', text: 'go' }),
        msg({ type: 'tool', toolName: 'Read', toolInput: 'main.ts' }),
        msg({ type: 'tool', toolName: 'Task', toolInput: 'map the event flow', subagentId: 'tu_a' }),
        msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'tu_a', subagentType: 'explore', subagentDescription: 'map the event flow' }),
        msg({ type: 'assistant', text: 'child notes', subagentId: 'tu_a', subagentType: 'explore' }),
        msg({ type: 'assistant', text: 'main answer' }),
      ] }]),
      [],
    );
    const kinds = rows.map(r => r.kind);
    // The main agent's own Read stays at the top level; the Task chip becomes the block.
    expect(kinds).toEqual(['divider', 'user', 'tools', 'subagent', 'assistant']);

    const block = rows[3] as Extract<ChatRow, { kind: 'subagent' }>;
    expect(block.id).toBe('tu_a');
    expect(block.agentType).toBe('explore');
    expect(block.description).toBe('map the event flow');
    expect(block.toolCount).toBe(1);
    // A main-agent row after the batch proves the subagents returned.
    expect(block.status).toBe('done');
    // The child's own rows live inside the block, never in the main stream.
    expect(block.children.map(r => r.kind)).toEqual(['tools', 'assistant']);
    expect((rows[2] as any).calls.map((c: any) => c.kind)).toEqual(['Read']);
  });

  it('keeps parallel subagents in separate blocks while their rows interleave', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'tool', toolName: 'Task', toolInput: 'first', subagentId: 'tu_a' }),
        msg({ type: 'tool', toolName: 'Task', toolInput: 'second', subagentId: 'tu_b' }),
        msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'tu_a' }),
        msg({ type: 'tool', toolName: 'Read', toolInput: 'y', subagentId: 'tu_b' }),
        msg({ type: 'tool', toolName: 'Read', toolInput: 'z', subagentId: 'tu_a' }),
      ] }]),
      [],
    );
    const blocks = rows.filter(r => r.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>[];
    expect(blocks.map(b => b.id)).toEqual(['tu_a', 'tu_b']);
    expect(blocks[0].toolCount).toBe(2);
    expect(blocks[1].toolCount).toBe(1);
    // A second Task in the same batch must not close the first block.
    expect(blocks[0].status).toBe('done');
  });

  it('collapses anonymous sidechain rows into one unnamed block', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'sidechain' }),
        msg({ type: 'assistant', text: 'notes', subagentId: 'sidechain' }),
      ] }]),
      [],
    );
    const blocks = rows.filter(r => r.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>[];
    expect(blocks.length).toBe(1);
    expect(blocks[0].agentType).toBeNull();
    expect(blocks[0].description).toBeNull();
  });

  it('leaves a block running while the session is still streaming', () => {
    const rows = buildTranscriptRows(
      tx([{ turnIndex: 0, messages: [
        msg({ type: 'tool', toolName: 'Task', toolInput: 'go look', subagentId: 'tu_a' }),
        msg({ type: 'tool', toolName: 'Grep', toolInput: 'x', subagentId: 'tu_a' }),
      ] }]),
      [],
      { streaming: true },
    );
    const block = rows.find(r => r.kind === 'subagent') as Extract<ChatRow, { kind: 'subagent' }>;
    expect(block.status).toBe('running');
  });

  it('carries subagent fields from a live session.message', () => {
    const live: LiveSessionMessage = {
      sessionId: 's1', role: 'assistant', text: 'notes', ts: T,
      subagentId: 'tu_a', subagentType: 'explore', subagentDescription: 'map it',
    };
    expect(liveToMessage(live)).toMatchObject({
      subagentId: 'tu_a', subagentType: 'explore', subagentDescription: 'map it',
    });
  });

  it('carries structured spawns from a live session.message', () => {
    const subagentSpawns = [{ id: 'tu_a', description: 'map it', prompt: 'full\nprompt' }];
    const live: LiveSessionMessage = {
      sessionId: 's1', role: 'tool', text: '', toolName: 'Agent', toolInput: 'map it', ts: T,
      subagentSpawns,
    };
    expect(liveToMessage(live).subagentSpawns).toEqual(subagentSpawns);
  });
});

describe('subagentModelLabel', () => {
  it('strips only the vendor prefix and the release date', () => {
    expect(subagentModelLabel('claude-sonnet-4-6-20260101')).toBe('sonnet-4-6');
    expect(subagentModelLabel('claude-haiku-4-5')).toBe('haiku-4-5');
  });

  it('shows an unrecognised id verbatim rather than guessing at it', () => {
    expect(subagentModelLabel('gpt-4o')).toBe('gpt-4o');
    expect(subagentModelLabel('deepseek-v3')).toBe('deepseek-v3');
    // 6 digits is not a release date — truncating here would invent a different model name.
    expect(subagentModelLabel('some-model-202601')).toBe('some-model-202601');
  });
});
