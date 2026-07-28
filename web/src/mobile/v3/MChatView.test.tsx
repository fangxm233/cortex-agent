// input:  mobile chat running state and send availability
// output: Send/Stop action visibility and disabled-state contracts
// pos:    Mobile chat interaction behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerFullscreen } from '@/mobile/ui/kit';
import { MChatView, type MChatCopy } from './MChatView';

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
