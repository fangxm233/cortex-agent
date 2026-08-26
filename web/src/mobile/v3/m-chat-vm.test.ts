// input:  Mobile chat view models and Vitest
// output: Mobile chat status/profile-label/row-model regressions
// pos:    Verifies mobile chat pure presentation logic
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry, SessionTranscript } from '@cortex-agent/ui-contract';
import {
  chatHeaderStatus,
  interactionHeaderStatus,
  effectiveProfileName,
  profileChipLabel,
  buildProfileSheetItems,
  buildMobileChatRows,
} from './m-chat-vm';

// The settings-editor fields (provider / claudeBackend / extraOption / extraEnvKeys / fallbackCount)
// play no part in the chat chip, so the factory supplies their empty shape.
function profile(over: Partial<ConfigProfileEntry> & Pick<ConfigProfileEntry, 'name'>): ConfigProfileEntry {
  return {
    model: null, backend: null, mode: null, thinking: null,
    provider: null, claudeBackend: null, extraOption: {}, extraEnvKeys: [], fallbackCount: 0,
    ...over,
  };
}

const profiles: ConfigProfileEntry[] = [
  profile({ name: 'default', model: 'sonnet-4.5', backend: 'claude', thinking: 'high' }),
  profile({ name: 'cheap', model: 'haiku-4', backend: 'claude' }),
  profile({ name: 'deep', model: 'opus-4.5', backend: 'pi' }),
];

describe('chatHeaderStatus', () => {
  it('classifies running and completed sessions without exposing mid-turn cost', () => {
    const running = chatHeaderStatus(true, 12, '2m 4s', 0.42, true);
    expect(running.running).toBe(true);
    expect(running.tone).toBe('running');
    expect(running.text).not.toContain('$');

    const completed = chatHeaderStatus(false, 12, '2m 4s', 0.42, true);
    expect(completed.running).toBe(false);
    expect(completed.tone).toBe('idle');
    expect(completed.text).toContain('$0.42');
  });

  it('keeps never-run sessions free of stale metrics', () => {
    const fresh = chatHeaderStatus(false, 3, '10s', 0.1, false);
    expect(fresh.running).toBe(false);
    expect(fresh.text).not.toContain('3');
    expect(fresh.text).not.toContain('$');
  });
});

describe('interactionHeaderStatus', () => {
  it('marks pending interactions as waiting and paused', () => {
    const s = interactionHeaderStatus('plan-approval', 0, 1, 'zh');
    expect(s.tone).toBe('waiting');
    expect(s.running).toBe(false);
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
  it('shows only the profile name in the composer selector', () => {
    expect(profileChipLabel('default')).toBe('default');
  });
});

describe('buildProfileSheetItems', () => {
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
  it('forwards stripScheduledPrefix so a scheduled run opens on a plain prompt bubble (8d)', () => {
    const rows = buildMobileChatRows(transcriptOf('[Scheduled Task] Scan arXiv'), [], {
      stripScheduledPrefix: true,
      now: new Date(TS),
    });
    expect(rows[1]).toMatchObject({ kind: 'user', text: 'Scan arXiv' });
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
