// input:  mobile chat rows, running state, and send availability
// output: Mobile message layout and composer action contracts
// pos:    Mobile chat interaction behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ComposerFullscreen } from '@/mobile/ui/kit';
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

describe('MChatStream interaction layout', () => {
  it('provides a flex column parent for right-aligned plan feedback', () => {
    const row: ChatRow = {
      kind: 'interaction',
      subtype: 'plan-approval',
      text: 'Plan rejected',
      detail: {
        id: 'plan-nimbus',
        kind: 'plan-approval',
        status: 'rejected',
        payload: { planContent: '# Nimbus plan' },
        result: { feedback: 'Align this note right' },
      },
    };

    const html = renderToStaticMarkup(<MChatStream rows={[row]} toolCallsUnit="tools" />);
    expect(html).toContain('<div style="display:flex;flex-direction:column"><div style="border:');
    expect(html).toContain('align-self:flex-end');
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
});

// The 7a action overlay used to be told only WHICH row was held, so it rendered at a fixed offset
// from the top of the screen and the floated copy of the bubble appeared far from the finger. The
// press now reports where the bubble is; this pins that half of the contract (the placement maths
// itself lives in m-chat-vm `msgMenuGroupTop`).
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
