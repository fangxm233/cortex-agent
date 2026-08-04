// input:  Command-palette mappers and neutral DTO fixtures
// output: Regression coverage for palette rows and targets
// pos:    Pure command-palette behavior tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { SessionInfo, ThreadInfo, TaskInfo } from '@cortex-agent/ui-contract';
import { buildCmdkItems, NAV_COMMAND_ITEMS, selectPaletteRows } from './palette-items';

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'sess_1',
    backendSessionId: null,
    name: 'morning review',
    projectId: 'cortex-self',
    backend: 'claude',
    kind: 'local',
    origin: 'direct',
    createdAt: '2026-07-06T07:00:00Z',
    lastUsedAt: '2026-07-06T07:42:00Z',
    resumable: true,
    label: null,
    profileName: null,
    running: false,
    backgroundRunning: false,
    awaitingInput: false,
    numTurns: null,
    costUsd: null,
    unread: false,
    scheduleId: null,
    ...over,
  };
}

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 'thr_8f2c',
    templateName: 'experiment-pipeline',
    currentStep: { index: 3, name: 'Review' },
    status: 'running',
    projectId: 'cortex-self',
    createdAt: '2026-07-06T07:00:00Z',
    updatedAt: '2026-07-06T07:42:00Z',
    totalSteps: 5,
    artifactPath: null,
    ...over,
  };
}

function task(over: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 'c967',
    text: 'Rebuild the command palette',
    project: 'cortex-self',
    status: 'open',
    priority: 'high',
    actionable: true,
    claimedBy: null,
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'coder-review',
    why: null,
    doneWhen: null,
    ...over,
  };
}

describe('buildCmdkItems', () => {
  it('maps a session to an SE row jumping to /workbench', () => {
    const [item] = buildCmdkItems({ sessions: [session()], threads: [], tasks: [] });
    expect(item.glyph).toBe('SE');
    expect(item.kbd).toBe('session');
    expect(item.label).toBe('morning review');
    expect(item.sub).toBe('cortex-self');
    expect(item.route).toBe('/workbench');
    expect(item.focusId).toBe('sess_1');
    expect(item.id).toBe('session:sess_1');
    expect(item.keywords).toContain('sess_1');
  });

  it('falls back to the sessionId when the session has no name', () => {
    const [item] = buildCmdkItems({
      sessions: [session({ name: '', sessionId: 'sess_x' })],
      threads: [],
      tasks: [],
    });
    expect(item.label).toBe('sess_x');
  });

  it('maps a thread to an in-place detail modal target', () => {
    const [item] = buildCmdkItems({ sessions: [], threads: [thread()], tasks: [] });
    expect(item.glyph).toBe('TH');
    expect(item.kbd).toBe('thread');
    expect(item.label).toBe('experiment-pipeline');
    expect(item.sub).toBe('thr_8f2c');
    expect(item.route).toBeUndefined();
    expect(item.modal).toBe('thread');
    expect(item.focusId).toBe('thr_8f2c');
    expect(item.id).toBe('thread:thr_8f2c');
    expect(item.keywords).toContain('thr_8f2c');
  });

  it('maps a task to a TK row jumping to /tasks with id·project sub', () => {
    const [item] = buildCmdkItems({ sessions: [], threads: [], tasks: [task()] });
    expect(item.glyph).toBe('TK');
    expect(item.kbd).toBe('task');
    expect(item.label).toBe('Rebuild the command palette');
    expect(item.sub).toBe('c967 · cortex-self');
    expect(item.route).toBe('/tasks');
    expect(item.focusId).toBe('c967');
    expect(item.id).toBe('task:c967');
    expect(item.keywords).toContain('c967');
  });

  it('returns items in stable sessions→threads→tasks order', () => {
    const items = buildCmdkItems({
      sessions: [session()],
      threads: [thread()],
      tasks: [task()],
    });
    expect(items.map((i) => i.glyph)).toEqual(['SE', 'TH', 'TK']);
  });

  it('produces collision-free cmdk values across kinds', () => {
    const items = buildCmdkItems({
      sessions: [session({ sessionId: 'x' })],
      threads: [thread({ id: 'x' })],
      tasks: [task({ id: 'x' })],
    });
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns no entity items for empty sources', () => {
    expect(buildCmdkItems({ sessions: [], threads: [], tasks: [] })).toEqual([]);
  });

  it('drops empty keyword tokens', () => {
    const [item] = buildCmdkItems({
      sessions: [session({ label: null, name: 'n' })],
      threads: [],
      tasks: [],
    });
    expect(item.keywords.every((k) => k.length > 0)).toBe(true);
  });
});

describe('NAV_COMMAND_ITEMS', () => {
  it('exposes Overview as a page and Settings as an in-place modal', () => {
    const byId = Object.fromEntries(NAV_COMMAND_ITEMS.map((c) => [c.id, c]));
    expect(byId['nav:overview']).toMatchObject({ glyph: 'OV', route: '/overview' });
    expect(byId['nav:settings']).toMatchObject({ glyph: 'ST', modal: 'settings' });
    expect(byId['nav:settings']).not.toHaveProperty('route');
  });

  it('every nav item has a unique id, one target, a glyph and a kbd tag', () => {
    const ids = NAV_COMMAND_ITEMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of NAV_COMMAND_ITEMS) {
      expect(Number(!!c.route) + Number(!!c.modal)).toBe(1);
      if (c.route) expect(c.route.startsWith('/')).toBe(true);
      expect(c.glyph.length).toBeGreaterThan(0);
      expect(c.kbd.length).toBeGreaterThan(0);
    }
  });
});

describe('selectPaletteRows', () => {
  const many = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i));
  const sources = {
    sessions: many(20, (i) => session({ sessionId: 'sess_' + i, name: 'sess ' + i })),
    threads: many(20, (i) => thread({ id: 'thr_' + i, templateName: 'tmpl-' + i })),
    tasks: many(20, (i) => task({ id: 'task_' + i, text: 'task text ' + i })),
  } as Parameters<typeof selectPaletteRows>[1];

  it('empty query → nav commands + capped entities per kind', () => {
    const rows = selectPaletteRows('', sources, { restPerKind: 5 });
    // 5 nav + 5 SE + 5 TH + 5 TK
    expect(rows.length).toBe(NAV_COMMAND_ITEMS.length + 15);
    expect(rows.slice(0, NAV_COMMAND_ITEMS.length).map((r) => r.id)).toEqual(
      NAV_COMMAND_ITEMS.map((c) => c.id),
    );
    expect(rows.filter((r) => r.glyph === 'SE').length).toBe(5);
    expect(rows.filter((r) => r.glyph === 'TH' && r.id.startsWith('thread:')).length).toBe(5);
  });

  it('query filters by substring across label/sub/keywords and caps the total', () => {
    const rows = selectPaletteRows('thr_7', sources, { matchCap: 50 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => (r.label + ' ' + r.sub + ' ' + r.keywords.join(' ')).toLowerCase().includes('thr_7'))).toBe(true);
    expect(rows[0].id).toBe('thread:thr_7');
  });

  it('honors the match cap', () => {
    const rows = selectPaletteRows('task', sources, { matchCap: 7 });
    expect(rows.length).toBe(7);
  });

  it('surfaces a nav command by keyword', () => {
    const rows = selectPaletteRows('settings', sources);
    expect(rows.some((r) => r.id === 'nav:settings')).toBe(true);
  });
});
