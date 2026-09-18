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
  useTRPC: () => ({
    sessions: {
      subagentTranscript: {
        queryOptions: (input: unknown) => ({ __kind: 'sessions.subagentTranscript', input }),
      },
    },
  }),
}));

import { LangProvider } from '@/i18n';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import { MChatStream, MChatView, type MChatCopy } from './MChatView';
import { ComposerAttachmentStrip } from './MChatAttachments';

const copy: MChatCopy = {
  composerPh: 'composer',
  toolCallsUnit: 'tools',
  menuSessionId: 'session-id',
  menuSessionStats: 'session-stats',
  sessionIdTitle: 'session-id',
  sessionStatsTitle: 'session-stats',
  sessionStatsHint: 'session-stats-hint',
  cortexIdLabel: 'cortex-id',
  backendUuidLabel: 'backend-id',
  copy: 'copy',
  copied: 'copied',
  attachCamera: 'camera',
  attachLibrary: 'library',
  attachFile: 'file',
  attachBrowser: 'browser',
  attachCommission: 'commission',
  attachCommands: 'commands',
  attachPlaceholder: 'attachment',
  profileTitle: 'profile',
  profileSubtitle: 'profile-subtitle',
  profileCurrent: 'current',
  profileFooter: 'profile-footer',
  selectionModel: 'model',
  selectionThinking: 'thinking',
  selectionMode: 'route',
  selectionFollow: 'follow profile',
  selectionFollowAll: 'follow the profile for everything',
  selectionHiddenModels: '{n} more models run on {backend}',
  selectionHiddenProfiles: '{n} more profiles run on {backend}',
  selectionHiddenNoProfile: '{n} more models have no profile',
  selectionPending: 'loading models',
  lineUnit: 'rows',
  charUnit: 'chars',
};

const baseProps = {
  title: 'session',
  copy,
  onBack: () => {},
  moreOpen: false,
  onMoreToggle: () => {},
  onMoreClose: () => {},
  sessionIdOpen: false,
  sessionStatsOpen: false,
  onSessionStatsOpen: () => {},
  onSessionStatsClose: () => {},
  onSessionIdOpen: () => {},
  onSessionIdClose: () => {},
  cortexId: null,
  backendUuid: null,
  composerValue: '',
  onComposerChange: () => {},
  onSend: () => {},
  sendEnabled: false,
  selectionChipLabel: 'claude-opus-5 · high',
  onOpenSelection: () => {},
  contextUsageOpen: false,
  onContextUsageOpen: () => {},
  onContextUsageClose: () => {},
  attachments: [],
  onRemoveAttachment: () => {},
  onRetryAttachment: () => {},
  onPlus: () => {},
  attachMenuOpen: false,
  onAttachClose: () => {},
  onCamera: () => {},
  onLibrary: () => {},
  onFile: () => {},
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

// The 7a action overlay used to be told only WHICH row was held, so it rendered at a fixed offset
// from the top of the screen and the floated copy of the bubble appeared far from the finger. The
// press now reports where the bubble is; this pins that half of the contract (the placement maths
// itself lives in m-chat-vm `msgMenuGroupTop`).
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
          <MChatStream rows={rows} toolCallsUnit="tools" copyLabel="copy" copiedLabel="copied" />
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
          <MChatStream rows={rows} toolCallsUnit="tools" copyLabel="copy" copiedLabel="copied" />
        </LangProvider>,
      );
    });
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());

    const text = (node: any): string => typeof node === 'string' ? node
      : Array.isArray(node) ? node.map(text).join('')
      : node?.children ? text(node.children) : '';
    const rendered = text(renderer.toJSON());
    const order = ['first note', '2 tools', 'second note', '1 tools']
      .map((needle) => rendered.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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
          <MChatStream rows={rows} toolCallsUnit="tools" copyLabel="copy" copiedLabel="copied" streamKey="s1" />
        </LangProvider>,
      );
    });

    expect(harness.queryCalls).toHaveLength(0);
    act(() => renderer.root.findByProps({ role: 'button' }).props.onClick());
    expect(harness.queryCalls).toHaveLength(1);
    expect(harness.queryCalls[0].input).toEqual({ sessionId: 's1', subagentId: 'tu_lazy' });

    const toolRow = renderer.root.findAll((node) => typeof node.props.onClick === 'function')[1];
    act(() => toolRow.props.onClick());

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Read');
    expect(rendered).toContain('a.ts');
    expect(rendered).toContain('child output');
    expect(rendered).not.toContain('hidden user');
  });
});
