// input:  Mobile chat view models and Vitest
// output: Mobile chat status/profile/row-model regressions
// pos:    Verifies mobile chat pure presentation logic
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry, SessionTranscript } from '@cortex-agent/ui-contract';
import {
  chatHeaderStatus,
  interactionHeaderStatus,
  effectiveProfileName,
  profileChipLabel,
  profileSub,
  buildProfileSheetItems,
  buildMobileChatRows,
} from './m-chat-vm';

const profiles: ConfigProfileEntry[] = [
  { name: 'default', model: 'sonnet-4.5', backend: 'claude', mode: null, thinking: 'high' },
  { name: 'cheap', model: 'haiku-4', backend: 'claude', mode: null, thinking: null },
  { name: 'deep', model: 'opus-4.5', backend: 'pi', mode: null, thinking: null },
];

describe('chatHeaderStatus', () => {
  // Mirrors the web composer status line (Composer.tsx): running shows time + turns (cost is not
  // known mid-turn); an idle-after-a-turn session adds cost; a fresh/never-run session is bare `idle`.
  it('running → `running · {elapsed} · {turns}` (no cost mid-turn)', () => {
    const s = chatHeaderStatus(true, 12, '2m 4s', null, true);
    expect(s.running).toBe(true);
    expect(s.text).toBe('running · 2m 4s · 12 turns');
    expect(s.text).not.toContain('$');
  });
  it('running with unknown turns → renders the — dash for turns', () => {
    expect(chatHeaderStatus(true, null, '5s', null, false).text).toBe('running · 5s · —');
  });
  it('idle after a turn → `idle · {elapsed} · {turns} · {cost}`', () => {
    expect(chatHeaderStatus(false, 12, '2m 4s', 0.42, true).text).toBe('idle · 2m 4s · 12 turns · $0.42');
  });
  it('idle after a turn with unknown cost → — dash for cost', () => {
    expect(chatHeaderStatus(false, 12, '2m 4s', null, true).text).toBe('idle · 2m 4s · 12 turns · —');
  });
  it('fresh / never-run session → bare `idle`', () => {
    expect(chatHeaderStatus(false, null, '—', null, false).text).toBe('idle');
    expect(chatHeaderStatus(false, 3, '10s', 0.1, false).text).toBe('idle');
  });
  it('carries a tone for the header dot (running/idle)', () => {
    expect(chatHeaderStatus(true, 1, '5s', null, true).tone).toBe('running');
    expect(chatHeaderStatus(false, 1, '5s', null, true).tone).toBe('idle');
  });
});

describe('interactionHeaderStatus (scheme-mobile 5a/5b/6a header line)', () => {
  it('pending plan → 计划待批 · Agent 已暂停 with the amber waiting tone', () => {
    const s = interactionHeaderStatus('plan-approval', 0, 1, 'zh');
    expect(s.tone).toBe('waiting');
    expect(s.running).toBe(false);
    expect(s.text).toBe('计划待批 · Agent 已暂停');
    expect(interactionHeaderStatus('plan-approval', 0, 1, 'en').text).toBe('plan pending · agent paused');
  });
  it('pending ask with several questions → 等待你的回答 k/n (k = current 1-based)', () => {
    expect(interactionHeaderStatus('ask-user', 1, 3, 'zh').text).toBe('等待你的回答 2/3 · Agent 已暂停');
    expect(interactionHeaderStatus('ask-user', 0, 3, 'en').text).toBe('awaiting your answer 1/3 · agent paused');
  });
  it('single-question ask omits the k/n counter', () => {
    expect(interactionHeaderStatus('ask-user', 0, 1, 'zh').text).toBe('等待你的回答 · Agent 已暂停');
  });
});

describe('effectiveProfileName', () => {
  it('prefers the session profile', () => {
    expect(effectiveProfileName('cheap', profiles, 'default')).toBe('cheap');
  });
  it('falls back to the config default, then the first profile, then —', () => {
    expect(effectiveProfileName(null, profiles, 'default')).toBe('default');
    expect(effectiveProfileName(null, profiles, null)).toBe('default');
    expect(effectiveProfileName(null, [], null)).toBe('—');
  });
});

describe('profileChipLabel', () => {
  it('renders `name · model`', () => {
    expect(profileChipLabel('default', profiles)).toBe('default · sonnet-4.5');
  });
  it('falls back to backend when model is null, then to bare name', () => {
    expect(profileChipLabel('x', [{ name: 'x', model: null, backend: 'claude', mode: null, thinking: null }])).toBe('x · claude');
    expect(profileChipLabel('x', [{ name: 'x', model: null, backend: null, mode: null, thinking: null }])).toBe('x');
    expect(profileChipLabel('missing', profiles)).toBe('missing');
  });
});

describe('profileSub / buildProfileSheetItems', () => {
  it('renders `model · thinking · backend`, dropping any missing segment', () => {
    expect(profileSub(profiles[0])).toBe('sonnet-4.5 · high · claude');
    // no thinking → just model · backend
    expect(profileSub(profiles[1])).toBe('haiku-4 · claude');
    expect(profileSub({ name: 'x', model: null, backend: 'claude', mode: null, thinking: null })).toBe('claude');
    expect(profileSub({ name: 'x', model: 'm', backend: null, mode: null, thinking: 'medium' })).toBe('m · medium');
  });
  it('marks the current profile', () => {
    const items = buildProfileSheetItems(profiles, 'cheap');
    expect(items.map((i) => i.name)).toEqual(['default', 'cheap', 'deep']);
    expect(items.find((i) => i.current)?.name).toBe('cheap');
    expect(items.filter((i) => i.current)).toHaveLength(1);
  });
});

// ── the mobile chat's row model ────────────────────────────────────────────────────────────────
//
// The mobile chat renders the SAME rows the desktop chat does — the block being written right now
// and any message the model has not read yet included. Both used to be dropped on the way in: the
// screen passed neither to the row builder, so a reply landed whole and a message sent mid-turn was
// invisible until the model read it. These lock that both reach the rows, and where they sit.

const TS = '2026-07-25T09:12:00.000Z';

function transcriptOf(...texts: string[]): SessionTranscript {
  return {
    sessionId: 's1',
    turns: [{
      turnIndex: 0,
      messages: texts.map((text, i) => ({
        type: 'user' as const,
        text,
        toolName: null,
        toolInput: null,
        ts: new Date(Date.parse(TS) + i * 1000).toISOString(),
        elapsedMs: null,
      })),
    }],
  } as SessionTranscript;
}

describe('buildMobileChatRows', () => {
  it('labels the day divider with the mobile zh vocabulary', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], { now: new Date(TS) });
    expect(rows[0].kind).toBe('divider');
    expect((rows[0] as { text: string }).text).toContain('今天');
  });

  it('renders the block being written as the last assistant row, flagged as the live preview', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], {
      streamingText: 'Tea begins as a',
      now: new Date(TS),
    });
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'assistant', text: 'Tea begins as a', preview: true });
  });

  it('pins a message the model has not read yet BELOW everything, including the live preview', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], {
      streamingText: 'Tea begins as a',
      pendingUser: [{ ts: TS, text: 'actually, stop' }],
      now: new Date(TS),
    });
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'user', text: 'actually, stop', pending: true });
    // …and the preview it must sit below is the row right above it.
    expect(rows[rows.length - 2]).toMatchObject({ kind: 'assistant', preview: true });
  });

  it('keeps several unread messages in send order among themselves', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], {
      pendingUser: [
        { ts: TS, text: 'first' },
        { ts: '2026-07-25T09:12:05.000Z', text: 'second' },
      ],
      now: new Date(TS),
    });
    expect(rows.slice(-2).map((r) => (r as { text: string }).text)).toEqual(['first', 'second']);
  });

  it('marks no row pending when nothing is waiting to be read', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], { now: new Date(TS) });
    expect(rows.some((r) => r.kind === 'user' && r.pending)).toBe(false);
  });
});
