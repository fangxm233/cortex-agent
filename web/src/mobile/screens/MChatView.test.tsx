import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({
  queryCalls: [] as any[],
  detail: {
    sessionId: 's1',
    subagentId: 'tu_lazy',
    messages: [
      { type: 'user', text: 'hidden user', toolName: null, toolInput: null, ts: '2026-08-01T01:00:00.000Z', elapsedMs: null },
      { type: 'tool', text: null, toolName: 'Read', toolInput: 'a.ts', ts: '2026-08-01T01:00:01.000Z', elapsedMs: 1000 },
      { type: 'assistant', text: 'child output', toolName: null, toolInput: null, ts: '2026-08-01T01:00:02.000Z', elapsedMs: 1000 },
    ],
  },
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: any) => {
      harness.queryCalls.push(options);
      if (options.__kind === 'sessions.subagentTranscript') {
        return { data: harness.detail, isPending: false, isError: false, refetch: vi.fn() };
      }
      return { data: undefined, isPending: false, isError: false, refetch: vi.fn() };
    },
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ sessions: { debugDetails: { query: vi.fn() } } }),
  useTRPC: () => ({
    sessions: {
      subagentTranscript: {
        queryOptions: (input: unknown) => ({ __kind: 'sessions.subagentTranscript', input }),
      },
    },
  }),
}));

// MBottomSheet's entrance animation needs rAF and window.history; these suites are about which
// sheet is up, so the chrome is stubbed as in MChatSheets' suite.
vi.mock('@/mobile/ui/kit', async () => ({
  ...(await vi.importActual<typeof import('@/mobile/ui/kit')>('@/mobile/ui/kit')),
  MBottomSheet: ({ children, onClose }: any) => <div data-bottom-sheet="" data-close={onClose}>{children}</div>,
}));
vi.mock('@/features/team/useWorkerQuestions', () => ({ useWorkerQuestions: () => ({}) }));
vi.mock('@/features/board/BoardCapsule', () => ({
  BoardChip: ({ boardId, onOpen }: { boardId: string; onOpen: () => void }) => <button data-board-chip={boardId} onClick={onOpen} />,
}));
vi.mock('@/features/board/BoardChatRows', () => ({
  BoardActionChatRow: ({ action, onOpen, touch }: { action: { boardId: string }; onOpen: (id: string) => void; touch?: boolean }) =>
    <button data-board-row={action.boardId} data-touch={touch} onClick={() => onOpen(action.boardId)} />,
}));
vi.mock('./MChatBoard', () => ({ MBoardSheet: ({ boardId }: { boardId: string }) => <div data-board-sheet={boardId} /> }));
vi.mock('@/features/browser/BrowserOptIn', () => ({
  useBrowserDeviceOptions: () => [{ device: null, label: 'Off', sub: '' }, { device: 'laptop', label: 'laptop', sub: '' }],
}));

import { LangProvider } from '@/i18n';
import type { ChatRow } from '@/features/session/transcript/transcript-vm';
import { SubagentBlock } from '@/features/session/transcript/SubagentBlock';
import { ToolCallsRow } from '@/features/session/transcript/ToolCallsRow';
import { MChatStream, MChatView } from './MChatView';
import { ComposerAttachmentStrip } from './MChatAttachments';
import type { MChatSelection } from './m-chat-selection';

const selection: MChatSelection = {
  open: false, setOpen: () => {}, agentOpen: false, setAgentOpen: () => {},
  agents: [], catalogLoading: false, modelsReady: true,
  effective: { backend: 'claude', model: 'claude-opus-5', provider: null, thinking: 'high', mode: 'plan' },
  favoriteOptions: [], modelGroups: [], thinkingOptions: [], modeOptions: [], rootRows: [],
  toggleFavorite: () => {}, agentOptions: [], agentName: null,
};

const baseProps = {
  title: 'session',
  onBack: () => {},
  backendUuid: null,
  composerValue: '',
  onComposerChange: () => {},
  onSend: () => {},
  sendEnabled: false,
  selection,
  onPickSelection: () => {},
  attachments: [],
  onRemoveAttachment: () => {},
  onRetryAttachment: () => {},
  onAddFiles: () => {},
};

function button(html: string, label: string): string | null {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? null;
}

function renderChat(running: boolean, sendEnabled: boolean): string {
  return renderToStaticMarkup(
    <MChatView
      {...baseProps}
      status={{ running, tone: running ? 'running' : 'idle', text: 'status' }}
      rows={[]}
      sendEnabled={sendEnabled}
      onStop={running ? () => {} : undefined}
    />,
  );
}

beforeEach(() => {
  harness.queryCalls = [];
});

describe('MChatView sticky agent clearance', () => {
  it('pins expanded agent headers below the title and top fade', () => {
    const rows: ChatRow[] = [{
      kind: 'subagent', id: 'tu_sticky', agentType: 'explore', description: 'Inspect layout',
      prompt: 'Inspect the transcript', model: null, status: 'running', toolCount: 1,
      children: [{ kind: 'assistant', text: 'child output', streaming: false }],
    }];
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<LangProvider><MChatView {...baseProps} rows={rows}
      status={{ running: true, tone: 'running', text: 'running' }} /></LangProvider>); });
    const scroller = renderer.root.findByProps({ 'data-transcript-scroller': true });
    expect(scroller.props.style['--transcript-sticky-top']).toBe('calc(var(--chat-header-bottom) + 12px)');
    expect(scroller.findAllByType('div')[1].props.style.padding).toBe('var(--transcript-sticky-top) 16px 0');
    const header = scroller.findByProps({ 'aria-expanded': false });
    act(() => header.props.onClick());
    expect(header.props['aria-expanded']).toBe(true);
    expect(header.props.style.top).toBe('var(--transcript-sticky-top, 0px)');
    act(() => renderer.unmount());
  });
});

describe('MChatView floating composer clearance', () => {
  it('reserves the whole shell as it grows and shrinks, without moving the composer', () => {
    let height = 94;
    const shell = { getBoundingClientRect: () => ({ height }) };
    let resize!: () => void;
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    let renderer!: ReactTestRenderer;
    try {
      act(() => { renderer = create(<MChatView {...baseProps} rows={[]}
        status={{ running: false, tone: 'idle', text: 'idle' }} />, {
        createNodeMock: (node) => node.props['data-composer-shell'] === true ? shell : null,
      }); });
      expect(observe).toHaveBeenCalledWith(shell, { box: 'border-box' });
      // Single line, four/five lines, an attachment/reject strip, then cleared.
      for (const [measured, reserved] of [[94, 150], [154, 210], [174, 230], [238.5, 294.5], [94, 150]]) {
        act(() => { height = measured; resize(); });
        expect(renderer.root.findByProps({ 'data-composer-clearance': true }).props.style.height)
          .toBe(`calc(${reserved}px + env(safe-area-inset-bottom))`);
        // The transcript fade ends at the shell top and follows it as the shell grows.
        const edge = `calc(100% - ${measured + 20}px - env(safe-area-inset-bottom))`;
        const style = renderer.root.findByProps({ 'data-transcript-scroller': true }).props.style;
        expect(style.maskImage)
          .toBe(`linear-gradient(to bottom, transparent var(--chat-header-bottom), #000 calc(var(--chat-header-bottom) + 12px), #000 calc(${edge} - 48px), transparent ${edge})`);
        expect(style.WebkitMaskImage).toBe(style.maskImage);
      }
      const header = renderer.root.findByProps({ 'data-chat-header': 'true' });
      expect(header.props.style.maskImage).toBeUndefined();
      expect(header.props.style.height).toBe(52);
      expect(renderer.root.findByProps({ 'data-chat-header-stack': '' }).props.style.top)
        .toBe('calc(8px + env(safe-area-inset-top))');
      expect(renderer.root.findByProps({ 'data-composer-shell': true }).props.style.bottom)
        .toBe('calc(20px + env(safe-area-inset-bottom))');
    } finally {
      act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('MChatView slash shortcuts', () => {
  it('renders enabled suggestions and ignores disabled picks', () => {
    const onSlashPick = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MChatView
          {...baseProps}
          status={{ running: false, tone: 'idle', text: 'idle' }}
          rows={[]}
          slashSuggestions={[
            { command: '/new', description: 'new', action: { type: 'new' }, disabled: false },
            { command: '/cancel', description: 'cancel', action: { type: 'cancel' }, disabled: true },
          ]}
          onSlashPick={onSlashPick}
        />,
      );
    });

    act(() => renderer.root.findByProps({ 'data-mobile-slash-command': '/new' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-mobile-slash-command': '/cancel' }).props.onClick());

    expect(onSlashPick).toHaveBeenCalledOnce();
    expect(onSlashPick.mock.calls[0][0].command).toBe('/new');
  });
});

describe('mobile attachment error actions', () => {
  it('requires an explicit retry or remove action for an error chip', () => {
    const retry = vi.fn();
    const remove = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(
      <ComposerAttachmentStrip
        attachments={[{ id: 'bad', name: 'bad.bin', progress: 0, status: 'error', type: 'file' }]}
        onRetry={retry}
        onRemove={remove}
      />,
    ); });

    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    act(() => renderer.root.findAll((node) => node.children.join('') === '✕')[0].props.onClick());
    expect(retry).toHaveBeenCalledWith('bad');
    expect(remove).toHaveBeenCalledWith('bad');
  });
});

describe('MChatView send controls', () => {
  it('keeps Send reachable beside Stop while a turn is running', () => {
    const html = renderChat(true, true);
    expect(button(html, 'Send')).not.toBeNull();
    expect(button(html, 'Stop')).not.toBeNull();
  });

  it('disables Send while running when there is nothing to send', () => {
    expect(button(renderChat(true, false), 'Send')).toContain('disabled');
  });
});

describe('MChatStream assistant turn copy', () => {
  it('renders one button per turn and copies all assistant text in that turn', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const rows: ChatRow[] = [
      { kind: 'user', text: 'first' },
      { kind: 'assistant', text: 'part one', streaming: false },
      { kind: 'tools', count: 1, calls: [{ kind: 'read', input: 'a.md' }] },
      { kind: 'assistant', text: 'part two', streaming: false },
      { kind: 'tools', count: 1, calls: [{ kind: 'bash', input: 'pwd' }] },
      {
        kind: 'subagent', id: 'tu_a', agentType: 'explore', description: 'inspect',
        prompt: 'inspect', model: 'model-x', status: 'done', toolCount: 1,
        children: [{ kind: 'assistant', text: 'child detail', streaming: false }],
      },
      { kind: 'user', text: 'second' },
      { kind: 'assistant', text: 'next turn', streaming: false },
    ];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <MChatStream rows={rows} />
        </LangProvider>,
      );
    });

    const buttons = renderer.root.findAllByProps({ 'data-assistant-turn-copy': 'true' });
    expect(buttons).toHaveLength(2);
    act(() => buttons[0].props.onClick());
    expect(writeText).toHaveBeenCalledWith('part one\n\npart two');
    vi.unstubAllGlobals();
  });
});

describe('MChatStream window', () => {
  it('mounts rows from the window start and keeps their transcript index', () => {
    const onLongPress = vi.fn();
    const rows: ChatRow[] = Array.from({ length: 6 }, (_, i) => ({ kind: 'user', text: `u${i}`, turnIndex: i }));
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <MChatStream rows={rows} start={4} onLongPress={onLongPress} />
        </LangProvider>,
      );
    });
    const bubbles = renderer.root.findAll((n) => typeof n.type === 'string' && n.props['data-msg-bubble'] !== undefined);
    expect(bubbles.map((n) => n.props['data-msg-bubble'])).toEqual([4, 5]);
  });
});

describe('MChatStream subagent prompt', () => {
  it('keeps the subagent body in transcript order — a tool run per step, not one merged run', () => {
    const rows: ChatRow[] = [{
      kind: 'subagent', id: 'tu_a', agentType: 'explore', description: 'Inspect mobile',
      prompt: null, model: null, status: 'done', toolCount: 3, children: [
        { kind: 'assistant', text: 'first note', streaming: false },
        { kind: 'tools', count: 2, calls: [{ kind: 'Read', input: 'a.ts' }, { kind: 'Bash', input: 'ls' }] },
        { kind: 'assistant', text: 'second note', streaming: false },
        { kind: 'tools', count: 1, calls: [{ kind: 'Write', input: 'b.ts' }] },
      ],
    }];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <MChatStream rows={rows} />
        </LangProvider>,
      );
    });
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(renderer.root.findByType(SubagentBlock).props.touch).toBe(true);
    expect(renderer.root.findAllByType(ToolCallsRow).map((row) => row.props.touch)).toEqual([true, true]);

    const text = (node: any): string => typeof node === 'string' ? node
      : Array.isArray(node) ? node.map(text).join('')
      : node?.children ? text(node.children) : '';
    const rendered = text(renderer.toJSON());
    const order = ['first note', '2 tool calls', 'second note', '1 tool call']
      .map((needle) => rendered.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('hands a tool row\'s images to the touch tool row, inside a subagent block too', () => {
    const images = [{ name: 'tu-0.png', path: 'workspace/tool-images/s1/tu-0.png' }];
    const rows: ChatRow[] = [
      { kind: 'tools', count: 1, calls: [{ kind: 'Read', input: '/a.png', images }] },
      {
        kind: 'subagent', id: 'tu_img', agentType: 'explore', description: 'look', prompt: null, model: null,
        status: 'done', toolCount: 1, children: [{ kind: 'tools', count: 1, calls: [{ kind: 'Read', input: '/b.png', images }] }],
      },
    ];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<LangProvider><MChatStream rows={rows} /></LangProvider>);
    });
    act(() => renderer.root.findAllByProps({ role: 'button' }).at(-1)!.props.onClick());
    const passed = renderer.root.findAllByType(ToolCallsRow).map((row) => row.props.calls[0].images);
    expect(passed).toEqual([images, images]);
  });

  it('loads lazy detail only after expand and keeps the mobile body to tools plus assistant prose', () => {
    const rows: ChatRow[] = [{
      kind: 'subagent', id: 'tu_lazy', agentType: 'explore', description: 'Inspect mobile',
      prompt: 'Prompt body', model: null, status: 'done', toolCount: 1, children: [],
      detailMode: 'lazy', hasDetails: true,
    } as Extract<ChatRow, { kind: 'subagent' }>];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LangProvider>
          <MChatStream rows={rows} streamKey="s1" />
        </LangProvider>,
      );
    });

    expect(harness.queryCalls).toHaveLength(0);
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(harness.queryCalls).toHaveLength(1);
    expect(harness.queryCalls[0].input).toEqual({ sessionId: 's1', subagentId: 'tu_lazy' });

    const toolRow = renderer.root.findByProps({ 'data-tool-calls': true }).findByType('button');
    act(() => toolRow.props.onClick());

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Read');
    expect(rendered).toContain('a.ts');
    expect(rendered).toContain('child output');
    expect(rendered).not.toContain('hidden user');
  });
});

// The header status line carries the project the session belongs to, not just the run state — on a
// phone the drill screen is the only place that fact is visible at all.
describe('MChatView header status line', () => {
  const line = (html: string): string =>
    html.match(/<div data-chat-status-line="true"[^>]*>([^<]*)</)?.[1] ?? '';

  it('prefixes the status with the project when one is known', () => {
    const html = renderToStaticMarkup(
      <MChatView {...baseProps} project="cortex-agent" rows={[]}
        status={{ running: true, tone: 'running', text: 'running 2m' }} />,
    );
    expect(line(html)).toBe('cortex-agent · running 2m');
  });

  it('falls back to the bare status with no project', () => {
    const html = renderToStaticMarkup(
      <MChatView {...baseProps} rows={[]} status={{ running: false, tone: 'idle', text: 'idle' }} />,
    );
    expect(line(html)).toBe('idle');
  });

  it('ticks a running turn clock every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <MChatView {...baseProps} rows={[]} status={{
            running: true, tone: 'running', text: 'settled',
            liveText: (now) => `running ${(now - 1_000_000) / 1000}s`,
          }} />,
        );
      });
      const text = () => renderer.root.findByProps({ 'data-chat-status-line': 'true' }).children.join('');
      expect(text()).toBe('running 0s');
      act(() => { vi.advanceTimersByTime(3000); });
      expect(text()).toBe('running 3s');
      act(() => renderer.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MChatView team context', () => {
  const status = { running: false, tone: 'idle' as const, text: 'idle' };
  const worker = (sessionId: string, inactive = false, extra: Record<string, unknown> = {}) => ({
    sessionId, projectId: 'p', label: null, origin: 'direct', teamLeadId: 'lead',
    workerName: 'w-' + sessionId, createdAt: '', lastUsedAt: inactive ? '2026-01-01T00:00:00Z' : '', ...extra,
  }) as unknown as import('@cortex-agent/ui-contract').SessionInfo;
  const mount = (extra: Record<string, unknown>) => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<LangProvider><MChatView {...baseProps} rows={[]} status={status} sessionId="lead" {...extra} /></LangProvider>); });
    return renderer;
  };
  const teamRows = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'button' && n.props['data-activity-chip'] === 'team');
  const crumbs = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'button' && n.props['data-lead-crumb'] !== undefined);
  const stack = (r: ReactTestRenderer) => r.root.findByProps({ 'data-chat-header-stack': '' });

  it('renders neither summary nor breadcrumb without a team', () => {
    const r = mount({ workers: [], parent: null, onOpenWorker: vi.fn() });
    expect(teamRows(r)).toHaveLength(0);
    expect(crumbs(r)).toHaveLength(0);
    const inactiveOnly = mount({ workers: [worker('w0', true)], onOpenWorker: vi.fn() });
    expect(teamRows(inactiveOnly)).toHaveLength(0);
    act(() => { r.unmount(); inactiveOnly.unmount(); });
  });

  it('puts the team in a capsule above the composer, not under the header, and opens the team sheet from it', () => {
    const onOpenWorker = vi.fn();
    const r = mount({ workers: [worker('w1', false, { running: true }), worker('w2'), worker('w3', true)], onOpenWorker });
    const row = teamRows(r)[0];
    expect(stack(r).findAll((n) => n.props['data-activity-chip'] !== undefined)).toHaveLength(0);
    expect(r.root.findByProps({ 'data-activity-strip': '' }).findAll((n) => n.props['data-activity-chip'] === 'team')).toHaveLength(1);
    expect(row.props['aria-label']).toContain('2 workers');
    expect(r.root.findAll((n) => n.props['data-team-sheet'] !== undefined)).toHaveLength(0);
    act(() => row.props.onClick({ stopPropagation: vi.fn() }));
    const sheet = r.root.findByProps({ 'data-team-sheet': '' });
    const workerRows = sheet.findAll((n) => n.type === 'button' && n.props['data-worker-row'] !== undefined);
    expect(workerRows.map((n) => n.props['data-worker-row'])).toEqual(['w1', 'w2']);
    expect(sheet.findByProps({ 'data-team-inactive': '' })).toBeTruthy();
    act(() => workerRows[1].props.onClick());
    expect(onOpenWorker).toHaveBeenCalledWith('w2');
    expect(r.root.findAll((n) => n.props['data-team-sheet'] !== undefined)).toHaveLength(0);
    act(() => r.unmount());
  });

  it('names the lead before the title and opens it on tap', () => {
    const onSelect = vi.fn();
    const r = mount({ parent: { title: 'Lead plan', onSelect } });
    const crumb = r.root.findByProps({ 'data-lead-crumb': '' });
    expect(crumb.props['aria-label']).toBe('Open lead session · Lead plan');
    act(() => crumb.props.onClick());
    expect(onSelect).toHaveBeenCalledOnce();
    act(() => r.unmount());
  });
});

// Which menu or sheet is up is the view's own state now; the screen only hands it domain actions.
describe('MChatView overlays', () => {
  const status = { running: false, tone: 'idle' as const, text: 'idle' };
  const mount = (extra: Record<string, unknown> = {}) => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<LangProvider><MChatView {...baseProps} rows={[]} status={status} sessionId="s1" {...extra} /></LangProvider>); });
    return renderer;
  };
  const byLabel = (r: ReactTestRenderer, label: string) =>
    r.root.findAll((n) => typeof n.type === 'string' && n.children.includes(label) && n.props.onClick)[0];
  const sheets = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'div' && n.props['data-bottom-sheet'] !== undefined);

  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });

  it('opens the task list and the waitpoints from their capsules as sheets', () => {
    const todos = {
      items: [{ content: 'Run the sweep', activeForm: 'Running the sweep', status: 'in_progress' as const }],
      total: 1, completed: 0, activeLabel: 'Running the sweep', updatedAt: 1,
    };
    const waitpoints = {
      waitpoints: [{
        id: 'wp_1', label: 'eval-job', intent: 'compare', state: 'armed', emitFrom: { kind: 'local' },
        quorum: { need: 1, got: 0, members: [] }, failFast: false, fires: 0, maxSignals: 1,
        createdAt: 0, expiresAt: Date.now() + 3_600_000, signals: [],
        delivery: { pending: false, attempts: 0, lastError: null, lastAt: null },
        wakesLastHour: 0, wakeLimit: 12, rateLimited: false,
      }],
      cancel: vi.fn(), cancelling: false,
    };
    const r = mount({ todos, waitpoints });
    const chip = (kind: string) => r.root.findByProps({ 'data-activity-chip': kind });
    expect(chip('wait').props['aria-label']).toContain('eval-job');
    act(() => chip('todo').props.onClick({ stopPropagation: vi.fn() }));
    expect(sheets(r)).toHaveLength(1);
    expect(sheets(r)[0].findAll((n) => n.props['data-todo-list'] !== undefined)).toHaveLength(1);
    act(() => chip('wait').props.onClick({ stopPropagation: vi.fn() }));
    expect(sheets(r)).toHaveLength(1);
    expect(sheets(r)[0].findAll((n) => n.props['data-wait-panel'] !== undefined)).toHaveLength(1);
    act(() => r.unmount());
  });

  it('shows no activity strip when there is nothing to show', () => {
    const r = mount();
    expect(r.root.findAll((n) => n.props['data-activity-strip'] !== undefined)).toHaveLength(0);
    act(() => r.unmount());
  });

  it('copies the stable session ID from the sheet and closes it on another session', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const r = mount({ backendUuid: 'backend-7' });
    act(() => r.root.findByProps({ 'aria-label': 'More' }).props.onClick());
    act(() => byLabel(r, 'Session ID').props.onClick());
    expect(byLabel(r, 'Session ID')).toBeUndefined();
    expect(sheets(r)).toHaveLength(1);
    const copies = r.root.findAll((n) => n.props.role === 'button' && n.children.includes('Copy'));
    expect(copies).toHaveLength(2);
    await act(async () => { copies[0].props.onClick(); });
    expect(writeText).toHaveBeenCalledWith('s1');
    act(() => r.update(<LangProvider><MChatView {...baseProps} rows={[]} status={status} sessionId="s2" /></LangProvider>));
    expect(sheets(r)).toHaveLength(0);
    act(() => r.unmount());
    vi.unstubAllGlobals();
  });

  it('opens the browser sheet from ＋ and sends the picked device', () => {
    const onPick = vi.fn();
    const r = mount({ browser: { device: null, onPick } });
    act(() => r.root.findByProps({ 'aria-label': 'Attach' }).props.onClick());
    act(() => r.root.findByProps({ 'data-plus-item': 'browser' }).props.onClick());
    expect(r.root.findAll((n) => n.props['data-plus-item'] !== undefined)).toHaveLength(0);
    act(() => r.root.findByProps({ 'data-device': 'laptop' }).props.onClick());
    expect(onPick).toHaveBeenCalledWith('laptop');
    expect(sheets(r)).toHaveLength(0);
    act(() => r.unmount());
    vi.unstubAllGlobals();
  });

  it('reports a live session\'s browser without offering to change it', () => {
    const r = mount({ browser: { device: 'laptop' } });
    expect(r.root.findByProps({ 'data-chip': 'browser' }).props.onClick).toBeUndefined();
    act(() => r.root.findByProps({ 'aria-label': 'Attach' }).props.onClick());
    expect(r.root.findByProps({ 'data-plus-item': 'browser' }).props['data-editable']).toBe('false');
    act(() => r.unmount());
    vi.unstubAllGlobals();
  });

  it('draws the engine chip off the selection and opens its sheet through it', () => {
    const setOpen = vi.fn();
    const r = mount({ selection: { ...selection, setOpen } });
    const chip = r.root.findByProps({ 'data-chip': 'selection' });
    expect(chip.props['aria-label']).toBe('opus-5 · high');
    act(() => chip.props.onClick());
    expect(setOpen).toHaveBeenCalledWith(true);
    expect(r.root.findAll((n) => n.props['data-chip'] === 'agent')).toHaveLength(0);
    act(() => r.unmount());
    vi.unstubAllGlobals();
  });

  it('hands an engine-sheet pick to the screen and closes the sheet', () => {
    const setOpen = vi.fn();
    const onPickSelection = vi.fn();
    const favoriteOptions: MChatSelection['favoriteOptions'] = [{
      id: 'fast', backend: 'claude', provider: null, group: 'claude', active: false,
      disabled: false, disabledReason: null, favorite: true, selection: { ...selection.effective, model: 'fast' },
    }];
    const r = mount({ selection: { ...selection, open: true, setOpen, favoriteOptions }, onPickSelection });
    act(() => r.root.findByProps({ 'data-selection-row': 'favorite:claude::fast' }).props.onClick());
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(onPickSelection.mock.calls[0][0]).toMatchObject({ id: 'favorite:claude::fast', label: 'fast' });
    act(() => r.unmount());
    vi.unstubAllGlobals();
  });
});

// The header stack's bottom edge is measured once and published; the transcript clearance, its
// fade and the ⋯ menu anchor all read that one variable instead of restating the geometry.
describe('MChatView header clearance', () => {
  it('publishes the measured bottom of the header stack and re-measures when it grows', () => {
    let bottom = 60;
    const callbacks: Array<() => void> = [];
    const resize = () => callbacks.forEach((callback) => callback());
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe = vi.fn();
      disconnect = vi.fn();
    });
    const rect = (top: number, bottomEdge: () => number) => ({ getBoundingClientRect: () => ({ top, bottom: bottomEdge(), height: bottomEdge() - top }) });
    const setProperty = vi.fn();
    let renderer!: ReactTestRenderer;
    try {
      act(() => { renderer = create(
        <LangProvider><MChatView {...baseProps} rows={[]} status={{ running: false, tone: 'idle', text: 'idle' }} /></LangProvider>,
        { createNodeMock: (node) => node.props['data-chat-header-stack'] === '' ? rect(8, () => bottom)
          : node.props['data-screen-label'] ? { ...rect(0, () => 844), style: { setProperty } } : null },
      ); });
      expect(setProperty).toHaveBeenLastCalledWith('--chat-header-bottom', '60px');
      act(() => { bottom = 94; resize(); });
      expect(setProperty).toHaveBeenLastCalledWith('--chat-header-bottom', '94px');
    } finally {
      act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});


it('shows history Retry only when the mobile transcript has no rows', () => {
  const onRetryTranscript = vi.fn();
  const props = { ...baseProps, rows: [], status: { running: false, text: 'idle', tone: 'idle' as const }, transcriptError: true, onRetryTranscript };
  const tree = create(<LangProvider><MChatView {...props} /></LangProvider>);
  const alert = tree.root.findByProps({ role: 'alert' });
  act(() => alert.findByType('button').props.onClick());
  expect(onRetryTranscript).toHaveBeenCalledOnce();
  act(() => tree.update(<LangProvider><MChatView {...props} rows={[{ kind: 'user', text: 'Visible' }]} /></LangProvider>));
  expect(tree.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
  act(() => tree.unmount());
});

describe('MChatView board capsule', () => {
  const status = { running: false, tone: 'idle' as const, text: 'idle' };
  const mount = (extra: Record<string, unknown>) => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<LangProvider><MChatView {...baseProps} rows={[]} status={status} sessionId="s1" {...extra} /></LangProvider>); });
    return renderer;
  };
  const bars = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'button' && n.props['data-board-chip'] !== undefined);

  it('sits in the activity strip of a bound session and opens the full-screen board', () => {
    const r = mount({ boardId: 'b1' });
    const stack = r.root.findByProps({ 'data-chat-header-stack': '' });
    expect(stack.findAll((n) => n.props['data-board-chip'] !== undefined)).toHaveLength(0);
    expect(r.root.findByProps({ 'data-activity-strip': '' }).findAll((n) => n.type === 'button' && n.props['data-board-chip'] === 'b1')).toHaveLength(1);
    act(() => bars(r)[0]!.props.onClick());
    expect(r.root.findAll((n) => n.props['data-board-sheet'] === 'b1')).toHaveLength(1);
    act(() => r.unmount());
  });

  it('is absent on an unbound session', () => {
    const r = mount({ boardId: null });
    expect(bars(r)).toHaveLength(0);
    act(() => r.unmount());
  });

  it('shows a board card in the stream that opens that board full-screen', () => {
    const rows: ChatRow[] = [
      { kind: 'user', text: 'plan it' },
      { kind: 'board-action', action: { boardId: 'b9', title: 'Survey', created: true, ts: null } },
    ];
    const r = mount({ boardId: null, rows });
    const row = r.root.find((n) => n.type === 'button' && n.props['data-board-row'] === 'b9');
    expect(row.props['data-touch']).toBe(true);
    act(() => row.props.onClick());
    expect(r.root.findAll((n) => n.props['data-board-sheet'] === 'b9')).toHaveLength(1);
    act(() => r.unmount());
  });
});
