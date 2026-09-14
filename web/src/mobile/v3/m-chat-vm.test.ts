import { describe, it, expect } from 'vitest';
import type { ConfigProfileEntry, ModelCatalogSnapshot, SessionTranscript } from '@cortex-agent/ui-contract';
import { effectiveSelection } from '@/features/workbench/selection-menu';
import { deriveSessionRunStatus } from '@/features/workbench/session-run-status';
import {
  chatHeaderStatus,
  interactionHeaderStatus,
  effectiveProfileName,
  selectionChipLabel,
  buildSelectionSheet,
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

const STATUS_COPY = {
  foreground: 'running', background: 'background', idle: 'idle', turnsUnit: 'turns',
};

function runStatus(running: boolean, backgroundRunning: boolean, hasRun: boolean) {
  return deriveSessionRunStatus({ running, backgroundRunning, hasRun });
}

describe('chatHeaderStatus', () => {
  it('formats foreground and completed sessions without exposing mid-turn cost', () => {
    const running = chatHeaderStatus(runStatus(true, false, true), 12, '2m 4s', 0.42, STATUS_COPY);
    expect(running.running).toBe(true);
    expect(running.tone).toBe('running');
    expect(running.text).toBe('running · 2m 4s · 12 turns');
    expect(running.text).not.toContain('$');

    const completed = chatHeaderStatus(runStatus(false, false, true), 12, '2m 4s', 0.42, STATUS_COPY);
    expect(completed.running).toBe(false);
    expect(completed.tone).toBe('idle');
    expect(completed.text).toBe('idle · 2m 4s · 12 turns · $0.42');
  });

  it('renders a background hold with background copy and an active tone', () => {
    const background = chatHeaderStatus(runStatus(true, true, true), 12, '2m 4s', 0.42, STATUS_COPY);
    expect(background).toEqual({
      running: true,
      tone: 'running',
      text: 'background · 2m 4s · 12 turns',
    });
  });

  it('keeps never-run sessions free of stale metrics', () => {
    const fresh = chatHeaderStatus(runStatus(false, false, false), 3, '10s', 0.1, STATUS_COPY);
    expect(fresh.running).toBe(false);
    expect(fresh.text).toBe('idle');
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

describe('selectionChipLabel', () => {
  it('shows what the next turn runs — the model, and the level when one is set', () => {
    expect(selectionChipLabel(effectiveSelection(profiles, 'default', null))).toBe('sonnet-4.5 · high');
    expect(selectionChipLabel(effectiveSelection(profiles, 'cheap', null))).toBe('haiku-4');
    expect(selectionChipLabel(effectiveSelection(profiles, 'default', { model: 'opus-4.9' })))
      .toBe('opus-4.9 · high');
  });

  it('falls back to the profile name when the profile declares no model', () => {
    expect(selectionChipLabel(effectiveSelection([profile({ name: 'bare' })], 'bare', null))).toBe('bare');
  });
});

describe('buildSelectionSheet', () => {
  const catalog: ModelCatalogSnapshot = {
    routes: [
      {
        endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'],
        models: ['sonnet-4.5', 'haiku-4'], source: 'builtin', modelThinking: {},
      },
      {
        endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'],
        models: ['opus-4.5'], source: 'pi', modelThinking: {},
      },
    ],
    thinkingLevels: { claude: ['low', 'high'], pi: ['off', 'high'] },
    piPending: false,
  };
  const copy = {
    profile: 'Profile', model: 'model', thinking: 'thinking', mode: 'route',
    followProfile: 'follow profile', followAll: 'follow the profile for everything',
    hiddenModels: '{n} more models run on {backend}',
    hiddenProfiles: '{n} more profiles run on {backend}',
    hiddenNoProfile: '{n} more models have no profile',
  };
  const sheet = (over: Partial<Parameters<typeof buildSelectionSheet>[0]> = {}) => buildSelectionSheet({
    profiles,
    catalog,
    effective: effectiveSelection(profiles, 'default', null),
    override: null,
    hasHistory: false,
    defaultProfile: 'default',
    copy,
    ...over,
  });

  it('reads profile first, then the overrides on top of it', () => {
    expect(sheet().sections.map((section) => section.key)).toEqual(['profile', 'model', 'thinking', 'mode']);
  });

  it('collapses every override into a root row showing the value in force', () => {
    expect(sheet().rootRows).toEqual([
      { key: 'model', label: 'model', value: 'sonnet-4.5', overridden: false },
      { key: 'thinking', label: 'thinking', value: 'high', overridden: false },
      { key: 'mode', label: 'route', value: '—', overridden: false },
    ]);
  });

  it('marks a root row the session chose for itself', () => {
    const rows = sheet({
      effective: effectiveSelection(profiles, 'default', { model: 'haiku-4' }),
      override: { model: 'haiku-4' },
    }).rootRows;
    expect(rows[0]).toMatchObject({ key: 'model', value: 'haiku-4', overridden: true });
    expect(rows[1]).toMatchObject({ key: 'thinking', overridden: false });
  });

  it('drops the route section when the endpoint bills only one way', () => {
    const oneLane: ModelCatalogSnapshot = {
      ...catalog,
      routes: catalog.routes.map((route) => ({ ...route, modes: [route.modes[0]] })),
    };
    const built = sheet({ catalog: oneLane });
    expect(built.sections.map((section) => section.key)).toEqual(['profile', 'model', 'thinking']);
    expect(built.rootRows.map((row) => row.key)).toEqual(['model', 'thinking']);
  });

  it('every section can be taken back to the profile, and says what that means', () => {
    const { sections } = sheet();
    const follow = sections[1].rows[0];
    expect(follow).toMatchObject({ id: 'model:follow', sub: 'sonnet-4.5', current: true });
    // Nothing is overridden, so there is nothing to take back.
    expect(follow.change).toBeNull();
    expect(sections[2].rows[0]).toMatchObject({ id: 'thinking:follow', sub: 'high', current: true });
  });

  it('offers to hand every override back at once, and only then', () => {
    expect(sheet().clearRow).toBeNull();
    expect(sheet({
      effective: effectiveSelection(profiles, 'default', { model: 'haiku-4' }),
      override: { model: 'haiku-4' },
    }).clearRow).toMatchObject({ id: 'selection:clear', change: { selection: {} } });
  });

  it('marks what is running now', () => {
    const { sections } = sheet();
    expect(sections[0].rows.find((row) => row.current)?.label).toBe('default');
    expect(sections[1].rows.find((row) => row.current && row.id !== 'model:follow')?.label).toBe('sonnet-4.5');
    expect(sections[2].rows.find((row) => row.current && row.id !== 'thinking:follow')?.label).toBe('high');
  });

  it('carries the change each row produces, restating the whole selection', () => {
    const { sections } = sheet({ effective: effectiveSelection(profiles, 'default', { thinking: 'low' }), override: { thinking: 'low' } });
    const haiku = sections[1].rows.find((row) => row.label === 'haiku-4')!;
    expect(haiku.change).toEqual({ selection: { thinking: 'low', model: 'haiku-4' } });
    const takeBack = sections[2].rows[0];
    expect(takeBack.change).toEqual({ selection: {} });
  });

  it('a live conversation is not offered the other backend at all — the footer accounts for it', () => {
    const { sections } = sheet({ hasHistory: true });
    expect(sections[1].rows.find((row) => row.label === 'opus-4.5')).toBeUndefined();
    expect(sections[1].footer).toBe('1 more models run on pi');
    expect(sections[0].rows.find((row) => row.label === 'deep')).toBeUndefined();
    expect(sections[0].footer).toBe('1 more profiles run on pi');
  });

  it('a draft may still cross backends, so nothing is held back', () => {
    const { sections } = sheet();
    expect(sections[1].rows.find((row) => row.label === 'opus-4.5')).toBeDefined();
    expect(sections[1].footer).toBeUndefined();
    expect(sections[0].footer).toBeUndefined();
  });

  it('hides a model no profile on this host can run, with a reason of its own', () => {
    const claudeOnly = profiles.filter((entry) => entry.backend !== 'pi');
    const { sections } = sheet({
      profiles: claudeOnly,
      effective: effectiveSelection(claudeOnly, 'default', null),
    });
    expect(sections[1].rows.find((row) => row.label === 'opus-4.5')).toBeUndefined();
    expect(sections[1].footer).toBe('1 more models have no profile');
  });

  it('offers no thinking section before the catalog arrives', () => {
    const { sections } = sheet({ catalog: null });
    expect(sections.map((section) => section.key)).toEqual(['profile', 'model']);
    expect(sections[1].rows.map((row) => row.id)).toEqual(['model:follow']);
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
