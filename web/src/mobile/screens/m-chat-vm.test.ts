import { describe, it, expect } from 'vitest';
import { zh } from '@/i18n';
import type { ConfigSnapshot, EngineSelection, ModelCatalogSnapshot, SessionTranscript } from '@cortex-agent/ui-contract';
import {
  buildFavoriteOptions, buildModelOptions, buildThinkingOptions, buildModeOptions,
  groupModelOptions, selectionRootRows,
} from '@/features/session/list/selection-menu';
import { modelKey } from '@/lib/model-selection';
import { interactionHeaderStatus, buildAgentSheet, buildSelectionSheet, buildMobileChatRows } from './m-chat-vm';

const current: EngineSelection = { backend: 'claude', provider: null, model: 'sonnet-4.5', thinking: 'high', mode: 'plan' };
const pi: EngineSelection = { backend: 'pi', provider: 'deepseek', model: 'deepseek-v4', thinking: 'xhigh', mode: 'deepseek' };
const models: ConfigSnapshot['models'] = {
  default: current,
  favorites: [current, pi],
  memory: { [modelKey(pi)]: { thinking: 'xhigh', mode: 'deepseek' } },
};
const catalog: ModelCatalogSnapshot = {
  routes: [
    { endpoint: 'anthropic', backend: 'claude', provider: null, modes: ['plan', 'api'], models: ['sonnet-4.5', 'haiku-4'], source: 'builtin', modelThinking: {} },
    { endpoint: 'deepseek', backend: 'pi', provider: 'deepseek', modes: ['deepseek'], models: ['deepseek-v4'], source: 'pi', modelThinking: {} },
  ],
  thinkingLevels: { claude: ['low', 'high'], pi: ['off', 'high'] }, piPending: false,
};
const copy = {
  favorites: 'Favorites', model: 'model', thinking: 'thinking', mode: 'route',
  defaultThinking: 'Default', crossBackend: 'New conversation only · {backend}',
};
function sheet(hasHistory = false, source: ModelCatalogSnapshot | null = catalog) {
  const thinkingOptions = buildThinkingOptions(source, current);
  const modeOptions = buildModeOptions(source, current);
  return buildSelectionSheet({
    effective: current, copy,
    favoriteOptions: buildFavoriteOptions(models, current, { hasHistory }),
    modelGroups: groupModelOptions(buildModelOptions(source, models, current, { hasHistory }), current.backend),
    thinkingOptions, modeOptions,
    rootRows: selectionRootRows(current, copy, { hasThinking: thinkingOptions.length > 1, hasModes: modeOptions.length > 0 }),
  });
}

describe('interactionHeaderStatus', () => {
  it('marks pending interactions as waiting and paused', () => {
    expect(interactionHeaderStatus('plan-approval', 0, 1, zh)).toMatchObject({ tone: 'waiting', running: false });
  });
});

describe('buildSelectionSheet', () => {
  it('renders favorites and their remembered thinking without a catalog', () => {
    const vm = sheet(false, null);
    expect(vm.sections[0].key).toBe('favorites');
    expect(vm.sections[0].rows[1]).toMatchObject({
      label: 'deepseek-v4', sub: 'xhigh', group: 'pi · deepseek', change: { selection: pi },
    });
    expect(vm.sections[1].rows).toEqual([]);
  });

  it('shows concrete model/thinking/route drill rows', () => {
    expect(sheet().rootRows).toEqual([
      { key: 'model', label: 'model', value: 'sonnet-4.5' },
      { key: 'thinking', label: 'thinking', value: 'high' },
      { key: 'mode', label: 'route', value: 'plan' },
    ]);
  });

  it('keeps cross-backend favorites and catalog models visible but disabled with a reason', () => {
    for (const section of sheet(true).sections.slice(0, 2)) {
      expect(section.rows.find((row) => row.label === 'deepseek-v4')).toMatchObject({
        disabled: true, change: null, sub: 'New conversation only · pi',
      });
    }
  });

  it('allows draft backend changes with a complete selection', () => {
    expect(sheet().sections[1].rows.find((row) => row.label === 'deepseek-v4')).toMatchObject({
      disabled: false, change: { selection: pi },
    });
  });

  it('provides favorite state for model stars and keeps an active model inert', () => {
    const rows = sheet().sections[1].rows;
    expect(rows[0]).toMatchObject({ current: true, change: null, modelOption: { favorite: true } });
    expect(rows[1]).toMatchObject({ current: false, modelOption: { favorite: false } });
  });

  it('default thinking writes null while preserving all other selection fields', () => {
    const row = sheet().sections.find((section) => section.key === 'thinking')!.rows[0];
    expect(row).toMatchObject({
      id: 'thinking:default', label: 'Default', change: { selection: { ...current, thinking: null } },
    });
  });

  it('mode writes a complete selection and a single route needs no pane', () => {
    expect(sheet().sections.find((section) => section.key === 'mode')!.rows[1].change)
      .toEqual({ selection: { ...current, mode: 'api' } });
    const single = { ...catalog, routes: catalog.routes.map((route) => ({ ...route, modes: [route.modes[0]] })) };
    expect(sheet(false, single).rootRows.map((row) => row.key)).toEqual(['model', 'thinking']);
  });
});

describe('buildAgentSheet', () => {
  const agents = [{ name: 'main', description: 'default environment' }, { name: 'nimbus', description: 'a clean room' }];
  const agentCopy = { agentDefault: 'default', agentFollowDefault: 'follow the host default' };
  const rows = (agentName: string | null = null) => buildAgentSheet({ agents, agentName, copy: agentCopy });

  it('offers the host default and independent environments', () => {
    expect(rows('nimbus')[0]).toMatchObject({ change: { agentName: null }, current: false });
    expect(rows()[1]).toMatchObject({ change: { agentName: 'main' } });
    expect(rows()[2]).toEqual({
      id: 'agent:nimbus', label: 'nimbus', sub: 'a clean room', current: false, change: { agentName: 'nimbus' },
    });
  });

  it('does not change an already selected environment', () => {
    expect(rows()[0]).toMatchObject({ current: true, change: null });
    expect(rows('nimbus')[2]).toMatchObject({ current: true, change: null });
  });
});

const TS = '2026-07-25T09:12:00.000Z';
function transcriptOf(...texts: string[]): SessionTranscript {
  return {
    sessionId: 's1',
    turns: [{ turnIndex: 0, messages: texts.map((text, i) => ({
      type: 'user' as const, text, toolName: null, toolInput: null,
      ts: new Date(Date.parse(TS) + i * 1000).toISOString(), elapsedMs: null,
    })) }],
  } as SessionTranscript;
}

describe('buildMobileChatRows', () => {
  it('forwards stripScheduledPrefix so a scheduled run opens on a plain prompt bubble', () => {
    const rows = buildMobileChatRows(transcriptOf('[Scheduled Task] Scan arXiv'), [], { stripScheduledPrefix: true, now: new Date(TS) });
    expect(rows[1]).toMatchObject({ kind: 'user', text: 'Scan arXiv' });
  });
  it('renders the streaming preview after committed rows', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], { streamingText: 'Tea begins as a', now: new Date(TS) });
    expect(rows.at(-1)).toMatchObject({ kind: 'assistant', text: 'Tea begins as a', preview: true });
  });
  it('pins unread messages below the preview', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], {
      streamingText: 'Tea begins as a', pendingUser: [{ ts: TS, text: 'actually, stop' }], now: new Date(TS),
    });
    expect(rows.at(-1)).toMatchObject({ kind: 'user', text: 'actually, stop', pending: true });
    expect(rows.at(-2)).toMatchObject({ kind: 'assistant', preview: true });
  });
  it('keeps several unread messages in send order', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], {
      pendingUser: [{ ts: TS, text: 'first' }, { ts: '2026-07-25T09:12:05.000Z', text: 'second' }], now: new Date(TS),
    });
    expect(rows.slice(-2).map((r) => (r as { text: string }).text)).toEqual(['first', 'second']);
  });
  it('marks no row pending when nothing is waiting to be read', () => {
    const rows = buildMobileChatRows(transcriptOf('hello'), [], { now: new Date(TS) });
    expect(rows.some((r) => r.kind === 'user' && r.pending)).toBe(false);
  });
});
