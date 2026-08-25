// input:  mobile rows, Todo snapshots, slash and send state
// output: Mobile Todo, message and composer interaction contracts
// pos:    Mobile chat interaction behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ComposerFullscreen, MComposer } from '@/mobile/ui/kit';
import type { TodoSnapshot } from '@cortex-agent/ui-contract';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import { MChatStream, MChatView, type MChatCopy, type MChatEditCopy } from './MChatView';

const copy: MChatCopy = {
  composerPh: 'composer',
  toolCallsUnit: 'tools',
  menuRename: 'rename',
  menuExport: 'export',
  menuArchive: 'archive',
  menuSessionId: 'session-id',
  sessionIdTitle: 'session-id',
  cortexIdLabel: 'cortex-id',
  backendUuidLabel: 'backend-id',
  copy: 'copy',
  copied: 'copied',
  attachCamera: 'camera',
  attachLibrary: 'library',
  attachFile: 'file',
  attachPlaceholder: 'attachment',
  profileTitle: 'profile',
  profileSubtitle: 'profile-subtitle',
  profileCurrent: 'current',
  profileFooter: 'profile-footer',
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
  onSessionIdOpen: () => {},
  onSessionIdClose: () => {},
  cortexId: null,
  backendUuid: null,
  composerValue: '',
  onComposerChange: () => {},
  onSend: () => {},
  sendEnabled: false,
  profileChipLabel: 'profile',
  onOpenProfile: () => {},
  contextUsageOpen: false,
  onContextUsageOpen: () => {},
  onContextUsageClose: () => {},
  attachments: [],
  onRemoveAttachment: () => {},
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

describe('MChatView Todo rail', () => {
  it('shows the selected session Todo summary above the composer', () => {
    const todos: TodoSnapshot = {
      items: [
        { content: 'Inspect state', activeForm: 'Inspecting state', status: 'in_progress' },
        { content: 'Apply fix', activeForm: 'Applying fix', status: 'pending' },
      ],
      total: 2,
      completed: 0,
      activeLabel: 'Inspecting state',
      updatedAt: 1,
    };
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: true, tone: 'running', text: 'running' }}
        rows={[]}
        sessionId="s1"
        todos={todos}
        todoLang="en"
      />,
    );

    expect(html).toContain('data-todo-rail="collapsed"');
    expect(html).toContain('0/2');
    expect(html).toContain('Inspecting state');
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

  it('shows Send without Stop while idle', () => {
    const html = renderChat(false, false);
    expect(button(html, 'Send')).not.toBeNull();
    expect(button(html, 'Stop')).toBeNull();
  });
});

describe('MComposer fullscreen commands', () => {
  it('collapses the fullscreen editor after a command pick', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MComposer
          value={'line one\nline two'}
          placeholder="composer"
          commandMenu={<button type="button" data-command-pick>pick</button>}
        />,
      );
    });
    act(() => renderer.root.findByProps({ 'aria-label': 'Expand' }).props.onClick());
    expect(renderer.root.findAllByProps({ 'aria-label': 'Collapse' })).toHaveLength(1);

    act(() => renderer.root.findByProps({ 'data-fullscreen-command-menu': true }).props.onClick());

    expect(renderer.root.findAllByProps({ 'aria-label': 'Collapse' })).toHaveLength(0);
  });
});

describe('ComposerFullscreen send controls', () => {
  function render(sendEnabled: boolean): string {
    return renderToStaticMarkup(
      <ComposerFullscreen
        value={sendEnabled ? 'message' : ''}
        placeholder="composer"
        onCollapse={() => {}}
        running
        sendEnabled={sendEnabled}
        onStop={() => {}}
        commandMenu={<div data-command-menu="true">commands</div>}
      />,
    );
  }

  it('keeps Send and Stop available while running', () => {
    const html = render(true);
    expect(button(html, 'Send')).not.toBeNull();
    expect(button(html, 'Stop')).not.toBeNull();
  });

  it('disables Send while running when the draft is empty', () => {
    expect(button(render(false), 'Send')).toContain('disabled');
  });

  it('keeps slash suggestions visible in the fullscreen editor', () => {
    expect(render(true)).toContain('data-command-menu="true"');
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
      { kind: 'user', text: 'second' },
      { kind: 'assistant', text: 'next turn', streaming: false },
    ];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MChatStream rows={rows} toolCallsUnit="tools" copyLabel="copy" copiedLabel="copied" />,
      );
    });

    const buttons = renderer.root.findAllByProps({ 'data-assistant-turn-copy': 'true' });
    expect(buttons).toHaveLength(2);
    act(() => buttons[0].props.onClick());
    expect(writeText).toHaveBeenCalledWith('part one\n\npart two');
    vi.unstubAllGlobals();
  });
});

describe('MChatStream long-press anchor', () => {
  const editCopy: MChatEditCopy = {
    menuCopy: '复制',
    menuEdit: '编辑消息',
    editingBadge: '编辑中',
    willRewind: () => 'rewind',
    editBarTitle: 'edit',
    edited: '已编辑',
    original: '原消息',
    regenNote: 'regen',
  };

  it('reports the held bubble position alongside the row index', () => {
    const held: Array<[number, number | null]> = [];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MChatStream
          rows={[{ kind: 'user', text: 'mobile端也要' } as ChatRow]}
          toolCallsUnit="tools"
          copyLabel="复制"
          copiedLabel="已复制"
          editCopy={editCopy}
          onLongPress={(rowIndex, anchorTop) => held.push([rowIndex, anchorTop])}
        />,
      );
    });
    const bubble = renderer.root.findAll((n) => n.props['data-msg-bubble'] === 0)[0];
    act(() => {
      bubble.props.onContextMenu({
        preventDefault: () => {},
        currentTarget: { getBoundingClientRect: () => ({ top: 512 }) },
      });
    });
    expect(held).toEqual([[0, 512]]);
  });
});

describe('MChatView browser chip', () => {
  function chip(html: string): string | null {
    return html.match(/<button[^>]*data-chip="browser"[^>]*>/)?.[0] ?? null;
  }

  function renderComposer(props: Record<string, unknown>): string {
    return renderToStaticMarkup(
      <MChatView
        {...baseProps}
        {...props}
        status={{ running: false, tone: 'idle', text: 'status' }}
        rows={[]}
      />,
    );
  }

  it('is absent when the session has no browser and none can be chosen', () => {
    // A live session that never opted in must not grow a control that would do nothing.
    expect(chip(renderComposer({}))).toBeNull();
  });

  it('is an editable toggle on a draft', () => {
    const html = renderComposer({ browserDevice: null, onToggleBrowser: () => {} });
    expect(chip(html)).toContain('data-editable="true"');
    expect(chip(html)).toContain('data-active="false"');
  });

  it('shows the chosen device once it is on', () => {
    const html = renderComposer({ browserDevice: 'server', onToggleBrowser: () => {}, browserChipLabel: 'Browser' });
    expect(chip(html)).toContain('data-active="true"');
    expect(html).toContain('Browser · server');
  });

  it('reports without offering a change on a live session', () => {
    // The agent's tool set is fixed when its process spawns, so a switch here would promise
    // something the running process cannot do.
    const html = renderComposer({ browserDevice: 'server' });
    expect(chip(html)).toContain('data-editable="false"');
    expect(chip(html)).toContain('disabled=""');
  });
});
