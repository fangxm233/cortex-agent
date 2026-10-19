import { describe, it, expect } from 'vitest';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { en, zh } from '@/i18n';
import {
  buildCmdkItems, groupPaletteRows, labelSegments, NAV_COMMAND_ITEMS, paletteGroupLabel, selectPaletteRows,
} from './palette-items';

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'sess_1',
    backendSessionId: null,
    projectId: 'cortex-self',
    backend: 'claude',
    kind: 'local',
    origin: 'direct',
    createdAt: '2026-07-06T07:00:00Z',
    lastUsedAt: '2026-07-06T07:42:00Z',
    resumable: true,
    label: null,
    selection: null,
    running: false,
    backgroundRunning: false,
    awaitingInput: false,
    numTurns: null,
    costUsd: null,
    unread: false,
    scheduleId: null,
    ...over,
    boardId: over.boardId ?? null,
    teamLeadId: over.teamLeadId ?? null,
    workerName: over.workerName ?? null,
  };
}

describe('buildCmdkItems', () => {
  it('maps a session to a row jumping to /workbench', () => {
    const [item] = buildCmdkItems({ sessions: [session()] });
    expect(item.route).toBe('/workbench');
    expect(item.focusId).toBe('sess_1');
    expect(item.projectId).toBe('cortex-self');
    expect(item.id).toBe('session:sess_1');
    expect(item.keywords).toContain('sess_1');
    expect(item.label).toBe('sess_1');
  });

  it('shows the first eight ID characters when no label exists', () => {
    const [item] = buildCmdkItems({ sessions: [session({ sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' })] });
    expect(item.label).toBe('abcdef12');
    expect(item.keywords).toContain('abcdef12-3456-7890-abcd-ef1234567890');
  });

  it('produces cmdk values that cannot collide with nav commands', () => {
    const items = buildCmdkItems({ sessions: [session({ sessionId: 'settings' })] });
    const ids = [...items.map((i) => i.id), ...NAV_COMMAND_ITEMS.map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('selectPaletteRows', () => {
  const many = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i));
  const sources = {
    sessions: many(20, (i) => session({ sessionId: 'sess_' + i })),
  } as Parameters<typeof selectPaletteRows>[1];

  it('empty query → nav commands + capped entities per kind', () => {
    const rows = selectPaletteRows('', sources, { restPerKind: 5 });
    // nav + 5 sessions
    expect(rows.length).toBe(NAV_COMMAND_ITEMS.length + 5);
    expect(rows.slice(0, NAV_COMMAND_ITEMS.length).map((r) => r.id)).toEqual(
      NAV_COMMAND_ITEMS.map((c) => c.id),
    );
    expect(rows.filter((r) => r.kbd === 'session').length).toBe(5);
  });

  it('query filters by substring across label/sub/keywords and caps the total', () => {
    const rows = selectPaletteRows('sess_7', sources, { matchCap: 50 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => (r.label + ' ' + r.sub + ' ' + r.keywords.join(' ')).toLowerCase().includes('sess_7'))).toBe(true);
    expect(rows[0].id).toBe('session:sess_7');
  });

  it('honors the match cap', () => {
    const rows = selectPaletteRows('sess', sources, { matchCap: 7 });
    expect(rows.length).toBe(7);
  });

  it('surfaces a nav command by keyword', () => {
    const rows = selectPaletteRows('settings', sources);
    expect(rows.some((r) => r.id === 'nav:settings')).toBe(true);
  });
});

function board(id: string, updatedAt = '2026-07-01T00:00:00Z'): BoardInfo {
  return { id, projectId: 'cortex-self', slug: 'slug-' + id, title: 'Board ' + id, createdAt: '2026-07-01T00:00:00Z', updatedAt };
}

describe('board rows', () => {
  // The server's order: most recently updated first.
  const boards = ['busy', 'quiet', 'older', 'oldest'].map((id) => board(id));

  it('maps a board to a row that opens it', () => {
    const [item] = buildCmdkItems({ sessions: [], boards: [boards[0]!] });
    expect(item).toMatchObject({ id: 'board:busy', kbd: 'board', boardId: 'busy', label: 'Board busy' });
  });

  it('lists the recent boards before sessions on an empty query, in the server\'s order', () => {
    const rows = selectPaletteRows('', { sessions: [session()], boards });
    expect(rows.slice(NAV_COMMAND_ITEMS.length).map((r) => r.id))
      .toEqual(['board:busy', 'board:quiet', 'board:older', 'board:oldest', 'session:sess_1']);
  });

  it('shows at most eight boards without a query, and searches them all with one', () => {
    const many = Array.from({ length: 12 }, (_, i) => board(`b${i}`));
    const rows = selectPaletteRows('', { sessions: [], boards: many });
    expect(rows.slice(NAV_COMMAND_ITEMS.length).map((r) => r.id)).toEqual(many.slice(0, 8).map((b) => 'board:' + b.id));
    expect(selectPaletteRows('b11', { sessions: [], boards: many }).map((r) => r.id)).toEqual(['board:b11']);
  });

  it('lists every board when the query names the kind', () => {
    const rows = selectPaletteRows('看板', { sessions: [session()], boards }, { kindWords: { board: '看板' } });
    expect(rows.map((r) => r.id)).toEqual(boards.map((b) => 'board:' + b.id));
  });
});

describe('palette groups', () => {
  it('splits the empty-query list into pages, actions, boards and sessions without reordering it', () => {
    const rows = selectPaletteRows('', { sessions: [session()], boards: [board('busy')] });
    const groups = groupPaletteRows(rows);
    expect(groups.map((g) => g.key)).toEqual(['page', 'action', 'board', 'session']);
    expect(groups.flatMap((g) => g.rows)).toEqual(rows);
  });

  it('names each group in sentence case, in either language', () => {
    expect(['page', 'action', 'board', 'session'].map((key) => paletteGroupLabel(key, en)))
      .toEqual(['Pages', 'Actions', 'Boards', 'Sessions']);
    expect(paletteGroupLabel('session', zh)).toBe('会话');
    expect(paletteGroupLabel('mystery', en)).toBe('mystery');
  });
});

describe('labelSegments', () => {
  it('marks the first case-insensitive occurrence of the query', () => {
    expect(labelSegments('Optimizer study: plan', 'opt')).toEqual([
      { text: 'Opt', match: true }, { text: 'imizer study: plan', match: false },
    ]);
    expect(labelSegments('Digits optimizer study', 'OPT')).toEqual([
      { text: 'Digits ', match: false }, { text: 'opt', match: true }, { text: 'imizer study', match: false },
    ]);
  });

  it('leaves a label whole when the row matched elsewhere or nothing was typed', () => {
    expect(labelSegments('Overview', 'dashboard')).toEqual([{ text: 'Overview', match: false }]);
    expect(labelSegments('Overview', '  ')).toEqual([{ text: 'Overview', match: false }]);
  });
});

describe('agent browser rows', () => {
  const browsers = [{ sessionId: 'sess_1', device: 'my-pc', url: 'https://example.com/login' }];

  it('lists live browsers first, labelled by their session and placed by device and page', () => {
    const rows = selectPaletteRows('', { sessions: [session({ label: 'Fix login' })], boards: [board('busy')], browsers });
    const browser = rows[NAV_COMMAND_ITEMS.length]!;
    expect(browser).toMatchObject({
      id: 'browser:sess_1', kbd: 'browser', label: 'Fix login', sub: 'my-pc · example.com',
      browserSessionId: 'sess_1', focusId: 'sess_1', projectId: 'cortex-self',
    });
    expect(groupPaletteRows(rows).map((g) => g.key)).toEqual(['page', 'action', 'browser', 'board', 'session']);
    expect(paletteGroupLabel('browser', en)).toBe('Agent browsers');
  });

  it('finds a browser by its page or its kind word', () => {
    expect(selectPaletteRows('example.com', { sessions: [session()], browsers }).map((r) => r.id)).toEqual(['browser:sess_1']);
    expect(selectPaletteRows('浏览器', { sessions: [session()], browsers }, { kindWords: { browser: '浏览器' } }).map((r) => r.id))
      .toEqual(['browser:sess_1']);
  });
});
