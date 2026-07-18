import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import {
  MChatView,
  MChatHeader,
  MChatStream,
  ProfileSheet,
  AttachMenu,
  MoreMenu,
  SessionIdSheet,
  type MChatCopy,
} from './MChatView';
import type { ProfileSheetItem, PendingAttachmentVM } from './m-chat-vm';

// Neutral fixtures only (守则11 — nimbus/atlas/orchard). The wired data-binding (sessions.transcript
// / setProfile / attachment upload) is proven in the live harness; these lock the 1:1 chrome vs the
// scheme sections 1b/1m/1n/1o/1p and the honest omit rules.

const copy: MChatCopy = {
  composerPh: '输入消息，/ 调用命令',
  toolCallsUnit: '次工具调用',
  menuRename: '重命名',
  menuExport: '导出',
  menuArchive: '归档',
  menuSessionId: '会话 ID',
  sessionIdTitle: '会话 ID',
  cortexIdLabel: 'Cortex ID',
  backendUuidLabel: '后端 UUID',
  copy: '复制',
  copied: '已复制',
  attachCamera: '拍照',
  attachLibrary: '照片图库',
  attachFile: '选择文件',
  attachFootnote: '上传完成前发送置灰 · 附件落 uploads/ 由 agent 读取',
  attachPlaceholder: '补充说明…',
  profileTitle: 'Profile',
  profileSubtitle: '仅本会话 · 热更新',
  profileCurrent: '当前',
  profileFooter: '切换仅影响本会话后续 turn',
  lineUnit: '行',
  charUnit: '字',
};

const baseProps = {
  title: 'nimbus review',
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
  profileChipLabel: 'default · sonnet-4.5',
  onOpenProfile: () => {},
  attachments: [] as PendingAttachmentVM[],
  onRemoveAttachment: () => {},
  onPlus: () => {},
  attachMenuOpen: false,
  onAttachClose: () => {},
  onCamera: () => {},
  onLibrary: () => {},
  onFile: () => {},
};

describe('1b MChatHeader', () => {
  it('renders the session name + running status line with a real turn count (no cost)', () => {
    const html = renderToStaticMarkup(
      <MChatHeader title="nimbus review" status={{ running: true, tone: 'running', text: 'running · 12 turns' }} onBack={() => {}} onMore={() => {}} />,
    );
    expect(html).toContain('nimbus review');
    expect(html).toContain('running · 12 turns');
    expect(html).not.toContain('$');
    expect(html).toContain('⋯');
    expect(html).toContain('cxpulse'); // running dot pulses
  });
  it('renders an idle status line without a pulse', () => {
    const html = renderToStaticMarkup(
      <MChatHeader title="atlas" status={{ running: false, tone: 'idle', text: 'idle · 3 turns' }} onBack={() => {}} onMore={() => {}} />,
    );
    expect(html).toContain('idle · 3 turns');
    expect(html).not.toContain('cxpulse');
  });
  it('waiting (pending interaction) → amber dot + amber text, no pulse (scheme 6a header)', () => {
    const html = renderToStaticMarkup(
      <MChatHeader title="atlas" status={{ running: false, tone: 'waiting', text: '计划待批 · 线程已暂停' }} onBack={() => {}} onMore={() => {}} />,
    );
    expect(html).toContain('计划待批 · 线程已暂停');
    expect(html).toContain('var(--m-amber)'); // amber dot
    expect(html).toContain('var(--m-amber-text)'); // amber status text
    expect(html).not.toContain('cxpulse');
  });
});

describe('1b MChatStream', () => {
  const rows: ChatRow[] = [
    { kind: 'divider', text: '今天 07:42' },
    { kind: 'user', text: 'how did the scan go?' },
    { kind: 'tools', count: 4, calls: [ { kind: 'read', input: 'a' }, { kind: 'grep', input: 'b' }, { kind: 'edit', input: 'c' }, { kind: 'bash', input: 'd' } ] },
    { kind: 'assistant', text: 'scan complete', streaming: true },
  ];
  const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次工具调用" />);
  it('renders divider, dark user bubble, collapsed tools, assistant text — no blinking caret', () => {
    expect(html).toContain('今天 07:42');
    expect(html).toContain('how did the scan go?');
    expect(html).toContain('var(--m-ink)');
    expect(html).toContain('次工具调用');
    expect(html).toContain('read');
    expect(html).toContain('+2'); // 4 calls, first-two chips + overflow
    expect(html).toContain('scan complete');
    // The blue blinking output-position block was removed by request.
    expect(html).not.toContain('cxblink');
  });
});

describe('interaction entity rows in the stream (scheme 6a/5b/4a-c)', () => {
  it('renders a pending plan row as the 6a thin card (file row entry, no content dump)', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'plan-pending', text: 'Plan submitted for approval',
      detail: { id: 'req-1', kind: 'plan-approval', status: 'pending', payload: { planContent: '# DR sweep plan\nstep one', planFilePath: 'plan/x.md' } },
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('计划待批');
    expect(html).toContain('DR sweep plan'); // heading-derived title (# stripped)
    expect(html).not.toContain('# DR sweep plan'); // no raw content dump in the thin card
    expect(html).toContain('批准并执行');
    expect(html).toContain('plan/x.md');
    expect(html).toContain('阅读 ›');
  });
  it('renders a pending ask-user row as the 5b progressive question card', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'ask-user-pending', text: 'A or B?',
      detail: { id: 'req-2', kind: 'ask-user', status: 'pending', payload: { questions: [{ question: 'A or B?', header: 'Q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } },
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('Agent 提问');
    expect(html).toContain('A or B?');
    expect(html).toContain('默认');
    expect(html).toContain('自定义…');
  });
  it('renders an approved plan row as the 4b sealed card', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'plan-approved', text: 'Plan approved',
      detail: { id: 'req-4', kind: 'plan-approval', status: 'approved', payload: { planContent: '# P', planFilePath: 'plan/x.md' } },
      ts: '2026-07-16T07:41:00Z',
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('✓ 计划已批准');
    expect(html).toContain('查看完整计划 ›');
    expect(html).not.toContain('批准并执行');
  });
  it('renders an expired interaction row as a grayed inactive summary (no buttons)', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'plan-expired', text: 'Plan approval expired',
      detail: { id: 'req-3', kind: 'plan-approval', status: 'expired', payload: { planContent: '# P', planFilePath: null } },
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('Plan approval expired');
    expect(html).not.toContain('批准并执行');
  });
  it('renders a legacy interaction row (no detail) as the old summary', () => {
    const rows: ChatRow[] = [{ kind: 'interaction', subtype: 'plan-approved', text: 'Plan approved' }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('Plan approved');
  });
});

describe('1o attachments in the stream', () => {
  it('renders sent attachments above the user bubble, right-aligned', () => {
    const rows: ChatRow[] = [
      { kind: 'user', text: 'look at this rollout', attachments: [
        { name: 'rollout.mp4', path: 'p', size: 1, mimeType: 'video/mp4', type: 'video' },
        { name: 'traj.csv', path: 'p2', size: 2, mimeType: 'text/csv', type: 'file' },
      ] },
    ];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('rollout.mp4');
    expect(html).toContain('traj.csv');
    expect(html).toContain('look at this rollout');
    // User attachments sit on the right (same side as the user bubble).
    expect(html).toContain('align-self:flex-end');
  });
  it('renders agent-sent attachments left-aligned (same side as the agent message)', () => {
    const rows: ChatRow[] = [
      { kind: 'assistant', text: 'here is the plot', streaming: false, attachments: [
        { name: 'result.png', path: 'p', size: 1, mimeType: 'image/png', type: 'image' },
      ] },
    ];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" />);
    expect(html).toContain('result.png');
    // Agent attachments must hug the left, not the right.
    expect(html).toContain('align-self:flex-start');
    expect(html).not.toContain('align-self:flex-end');
  });
});

describe('5a reject-feedback composer mode', () => {
  it('renders the amber context bar + reason chips + amber composer ring', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: false, tone: 'waiting', text: '计划待批 · 线程已暂停' }}
        rows={[]}
        rejectBar={{
          title: '驳回「DR 扫描」— 说明原因后发送',
          chips: ['范围太大', '先做 dry-run'],
          onChipTap: () => {},
          onCancel: () => {},
        }}
      />,
    );
    expect(html).toContain('驳回「DR 扫描」— 说明原因后发送');
    expect(html).toContain('范围太大');
    expect(html).toContain('先做 dry-run');
    expect(html).toContain('✕'); // cancel back to pending
    expect(html).toContain('var(--m-amber)'); // amber composer border
    expect(html).toContain('var(--m-amber-card)'); // amber context bar bg
  });
});

describe('1o AttachMenu', () => {
  it('renders 拍照 / 照片图库 / 选择文件', () => {
    const html = renderToStaticMarkup(<AttachMenu copy={copy} onClose={() => {}} onCamera={() => {}} onLibrary={() => {}} onFile={() => {}} />);
    expect(html).toContain('拍照');
    expect(html).toContain('照片图库');
    expect(html).toContain('选择文件');
  });
});

describe('1p ProfileSheet', () => {
  const items: ProfileSheetItem[] = [
    { name: 'default', sub: 'sonnet-4.5 · anthropic', current: true },
    { name: 'cheap', sub: 'haiku-4 · anthropic', current: false },
  ];
  it('renders the title, every profile row with model/backend, and the 当前 badge on the active one', () => {
    const html = renderToStaticMarkup(<ProfileSheet items={items} copy={copy} onClose={() => {}} onPick={() => {}} />);
    expect(html).toContain('Profile');
    expect(html).toContain('default');
    expect(html).toContain('sonnet-4.5 · anthropic');
    expect(html).toContain('cheap');
    expect(html).toContain('当前');
    expect(html).toContain('切换仅影响本会话后续 turn');
  });
});

describe('1b MChatView composition', () => {
  it('renders header + composer with the profile chip and the ＋ attach affordance', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: true, tone: 'running', text: 'running · 2m 4s · 5 turns' }}
        rows={[{ kind: 'assistant', text: 'hello', streaming: false }]}
        systemLines={['profile 切换 default → cheap · 下一 turn 生效']}
      />,
    );
    expect(html).toContain('nimbus review');
    expect(html).toContain('running · 2m 4s · 5 turns'); // status now lives in the header
    expect(html).toContain('default · sonnet-4.5'); // profile chip
    expect(html).toContain('＋'); // attach affordance
    expect(html).toContain('hello');
    expect(html).toContain('profile 切换 default → cheap · 下一 turn 生效'); // system line
  });
  it('shows a Stop button (not Send) while the session is running', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: true, tone: 'running', text: 'running · 12 turns' }}
        rows={[]}
        onStop={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Send"');
  });
  it('shows the Send button (not Stop) when idle', () => {
    const html = renderToStaticMarkup(
      <MChatView {...baseProps} status={{ running: false, tone: 'idle', text: 'idle' }} rows={[]} />,
    );
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop"');
  });
  it('shows the attachment footnote + placeholder when uploads are present', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: false, tone: 'idle', text: 'idle' }}
        rows={[]}
        attachments={[{ id: 'a1', name: 'IMG_1.jpg', progress: 64, status: 'uploading' }]}
      />,
    );
    expect(html).toContain('IMG_1.jpg');
    expect(html).toContain('64%');
    expect(html).toContain('补充说明…');
    expect(html).toContain('由 agent 读取');
  });
});

describe('⋯ → 会话ID (MoreMenu + SessionIdSheet)', () => {
  it('MoreMenu lists 会话ID above the inert rename/export/archive items', () => {
    const html = renderToStaticMarkup(<MoreMenu copy={copy} onClose={() => {}} onSessionId={() => {}} />);
    expect(html).toContain('会话 ID');
    expect(html).toContain('重命名');
    expect(html).toContain('导出');
    expect(html).toContain('归档');
  });
  it('SessionIdSheet shows the Cortex ID and backend UUID with their real values', () => {
    const html = renderToStaticMarkup(
      <SessionIdSheet
        copy={copy}
        cortexId="cortex-0042"
        backendUuid="11111111-2222-3333-4444-555555555555"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('Cortex ID');
    expect(html).toContain('cortex-0042');
    expect(html).toContain('后端 UUID');
    expect(html).toContain('11111111-2222-3333-4444-555555555555');
    expect(html).toContain('复制');
  });
  it('SessionIdSheet falls back to a dash when an id is missing (never fabricated)', () => {
    const html = renderToStaticMarkup(
      <SessionIdSheet copy={copy} cortexId={null} backendUuid={null} onClose={() => {}} />,
    );
    expect(html).toContain('—');
  });
  it('MChatView renders the Session ID sheet when sessionIdOpen', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: false, tone: 'idle', text: 'idle' }}
        rows={[]}
        sessionIdOpen
        cortexId="cortex-0007"
        backendUuid="uuid-abc"
      />,
    );
    expect(html).toContain('cortex-0007');
    expect(html).toContain('uuid-abc');
  });
});
