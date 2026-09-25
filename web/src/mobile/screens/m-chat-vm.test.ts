import { describe, it, expect } from 'vitest';
import type {
  ConfigAgentEntry, ConfigProfileEntry, ModelCatalogSnapshot, SessionTranscript,
} from '@cortex-agent/ui-contract';
import { effectiveSelection } from '@/features/session/list/selection-menu';
import {
  interactionHeaderStatus,
  effectiveProfileName,
  buildAgentSheet,
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

  it('the ticked profile row takes the overrides back, and is inert without them', () => {
    const overridden = sheet({
      effective: effectiveSelection(profiles, 'default', { model: 'haiku-4' }),
      override: { model: 'haiku-4' },
    }).sections[0].rows.find((row) => row.current)!;
    expect(overridden).toMatchObject({ current: true, change: { profileName: 'default' } });
    expect(sheet().sections[0].rows.find((row) => row.current)?.change).toBeNull();
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

  it('carries no environment at all — the agent is a sheet of its own', () => {
    const { sections, rootRows } = sheet();
    expect(sections.map((section) => section.key)).not.toContain('agent');
    expect(sections.flatMap((section) => section.rows).map((row) => row.id))
      .not.toContain('agent:default');
    expect(rootRows.map((row) => row.key)).toEqual(['model', 'thinking', 'mode']);
  });
});

// ── the environment sheet ──────────────────────────────────────────────────────────────────────
// One flat list, and the one list that draws what it cannot offer: a handful of environments is
// not a screenful of models, so an agent that needs a new conversation is named rather than counted.

describe('buildAgentSheet', () => {
  const agents: ConfigAgentEntry[] = [
    { name: 'main', description: 'the default environment', profile: '__active__' },
    { name: 'nimbus', description: 'a clean room', profile: '__active__' },
    { name: 'atlas', description: 'pinned to the other backend', profile: 'deep' },
  ];
  const copy = {
    agentDefault: 'default',
    agentFollowDefault: 'follow the host default',
    agentCrossBackend: 'new conversation only · {backend}',
  };
  const rows = (over: Partial<Parameters<typeof buildAgentSheet>[0]> = {}) => buildAgentSheet({
    agents, profiles, agentName: null, currentBackend: 'claude', hasHistory: false, copy, ...over,
  });

  it('leads with the row that hands the conversation back to the host default', () => {
    const [first] = rows({ agentName: 'nimbus' });
    expect(first).toEqual({
      id: 'agent:default',
      label: 'default',
      sub: 'follow the host default',
      current: false,
      change: { agentName: null },
    });
    // Nothing to hand back when it is already following: the row is drawn, but inert.
    expect(rows()[0]).toMatchObject({ current: true, change: null });
  });

  it('names each environment, what it pins and what it is for', () => {
    expect(rows().find((row) => row.id === 'agent:nimbus')).toEqual({
      id: 'agent:nimbus',
      label: 'nimbus',
      sub: 'a clean room',
      current: false,
      change: { agentName: 'nimbus' },
    });
    expect(rows().find((row) => row.id === 'agent:atlas')?.sub).toBe('deep · pinned to the other backend');
  });

  it('draws the one a live conversation cannot take, and says which backend it needed', () => {
    const row = rows({ hasHistory: true }).find((entry) => entry.id === 'agent:atlas');
    expect(row).toMatchObject({ disabled: true, sub: 'new conversation only · pi', change: null });
  });

  it('ticks the one the conversation is running in, and offers it no change', () => {
    const row = rows({ agentName: 'nimbus' }).find((entry) => entry.id === 'agent:nimbus');
    expect(row).toMatchObject({ current: true, change: null });
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
