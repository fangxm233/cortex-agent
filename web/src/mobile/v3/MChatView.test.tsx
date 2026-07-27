// input:  Mobile chat components, view models, and server-side renderer
// output: Mobile chat chrome and interaction rendering regressions
// pos:    Verifies the mobile session-chat presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
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
import { ComposerFullscreen } from '@/mobile/ui/kit';
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
      <MChatHeader title="atlas" status={{ running: false, tone: 'waiting', text: '计划待批 · Agent 已暂停' }} onBack={() => {}} onMore={() => {}} />,
    );
    expect(html).toContain('计划待批 · Agent 已暂停');
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

// A message sent while a turn is running is only QUEUED inside the backend — the model may not read
// it for seconds, sometimes not before the turn ends. Until then its row says so with DIMMED TEXT and
// nothing else: the same dark bubble, no icon, no badge, no spinner, no opacity fade. The moment the
// model reads it the row becomes an ordinary one, so the difference has to be carried by the ink
// alone. (Mirrors the desktop rule — same bubble, muted ink; the mobile bubble is ink-on-dark, so the
// muted value is the dimmed on-ink foreground rather than the desktop's muted ink.)

const ON_INK = 'var(--ink-solid-fg)';
const ON_INK_DIM = 'var(--ink-solid-fg-dim)';

/** The style block of the bubble carrying `text` (the innermost div holding it). */
function bubbleStyle(html: string, text: string): string {
  const at = html.indexOf(text);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div style="', at);
  return html.slice(open, at);
}

describe('MChatStream — a user message the model has not read yet', () => {
  const render = (rows: ChatRow[]): string =>
    renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次工具调用" />);

  it('renders its text in the dimmed on-ink foreground, not the full-strength one', () => {
    const style = bubbleStyle(render([{ kind: 'user', text: 'actually, stop', pending: true }]), 'actually, stop');
    expect(style).toContain(ON_INK_DIM);
    expect(style).not.toContain(`color:${ON_INK}`);
  });

  it('renders an ordinary user message in the full-strength on-ink foreground', () => {
    const style = bubbleStyle(render([{ kind: 'user', text: 'actually, stop' }]), 'actually, stop');
    expect(style).toContain(ON_INK);
    expect(style).not.toContain(ON_INK_DIM);
  });

  it('changes nothing but the ink — same dark bubble, no opacity fade', () => {
    const pending = bubbleStyle(render([{ kind: 'user', text: 'hold on', pending: true }]), 'hold on');
    const settled = bubbleStyle(render([{ kind: 'user', text: 'hold on' }]), 'hold on');
    expect(pending).toContain('var(--m-ink)');
    expect(pending).not.toContain('opacity');
    expect(pending.replace(ON_INK_DIM, ON_INK)).toBe(settled);
  });

  it('carries no spinner, badge or status label', () => {
    const html = render([{ kind: 'user', text: 'hold on', pending: true }]);
    expect(html).not.toMatch(/pending|queued|sending|待读|cxblink/i);
  });

  it('renders attachments on a pending row exactly as usual', () => {
    const html = render([{
      kind: 'user', text: 'look at this', pending: true,
      attachments: [{ name: 'shot.png', path: 'p', size: 12, mimeType: 'image/png', type: 'image' }],
    }]);
    expect(html).toContain('shot.png');
  });
});

// Token-level streaming: the reply grows instead of landing whole. The reveal itself is rAF-driven
// and the vitest env here is `node`, so the pacing rule is proven by reveal-pacing.test.ts — what
// these lock is the ROUTING, i.e. which rows go through the paced path at all. Getting that wrong is
// what a reader would notice: an already-final reply re-typing itself, or an animation still running
// after the turn went idle. Still no caret (that was removed by request).

describe('MChatStream — the block being written right now', () => {
  const LONG = 'Tea begins as a leaf, and ends as a habit.';
  const render = (rows: ChatRow[], streamKey?: string): string =>
    renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次工具调用" streamKey={streamKey} />);

  it('paces the live preview instead of dumping the whole buffer on arrival', () => {
    // The preview row starts empty and is filled by the rAF reveal; with no frames in this env it
    // stays at its starting point, which is exactly what "not appended whole" looks like.
    expect(render([{ kind: 'assistant', text: LONG, streaming: true, preview: true }])).not.toContain(LONG);
  });

  it('shows an authoritative message in full even while the session still reads as streaming', () => {
    // The handover instant: the complete message has landed and the preview is retired, but the idle
    // heuristic still flags the row `streaming` for a couple of seconds. Nothing may animate here.
    expect(render([{ kind: 'assistant', text: LONG, streaming: true }])).toContain(LONG);
  });

  it('shows a completed message in full', () => {
    expect(render([{ kind: 'assistant', text: LONG, streaming: false }])).toContain(LONG);
  });

  it('renders no caret for the block being written', () => {
    expect(render([{ kind: 'assistant', text: LONG, streaming: true, preview: true }])).not.toContain('cxblink');
  });

  it('renders the preview under a stream key without disturbing its text', () => {
    // The per-session isolation is compared by identity inside the reveal; passing one changes
    // nothing visible here.
    const rows: ChatRow[] = [{ kind: 'assistant', text: LONG, streaming: true, preview: true }];
    expect(render(rows, 'session-a')).toBe(render(rows, 'session-b'));
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
        status={{ running: false, tone: 'waiting', text: '计划待批 · Agent 已暂停' }}
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
  // Sending INTO a running turn is the point of mid-turn injection — the server injects the message
  // into the turn instead of queuing it behind it. A composer that hides Send while running puts that
  // out of reach on a phone entirely (there is no ⏎-to-send here: Enter inserts a newline by design,
  // so the button IS the only send path). Stop keeps the primary, far-right key it always had; Send
  // returns beside it as a secondary one.
  it('keeps Send reachable beside Stop while the session is running', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: true, tone: 'running', text: 'running · 12 turns' }}
        rows={[]}
        sendEnabled
        onStop={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain('aria-label="Send"');
  });
  it('leaves the running Send inert when there is nothing to send', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: true, tone: 'running', text: 'running · 12 turns' }}
        rows={[]}
        sendEnabled={false}
        onStop={() => {}}
      />,
    );
    const send = html.slice(html.indexOf('aria-label="Send"'), html.indexOf('aria-label="Stop"'));
    expect(send).toContain('disabled');
  });
  it('arms the running Send when the composer holds something to send', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: true, tone: 'running', text: 'running · 12 turns' }}
        rows={[]}
        composerValue="actually, stop"
        sendEnabled
        onStop={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Send"');
    const send = html.slice(html.indexOf('aria-label="Send"'), html.indexOf('aria-label="Stop"'));
    expect(send).not.toContain('disabled');
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
  });
});

describe('2b full-screen editor — the other send path', () => {
  // The expanded editor is the composer's second send affordance. It swapped Send for Stop on the
  // same rule the inline field did, so expanding mid-turn was another dead end.
  it('keeps Send reachable beside Stop while the session is running', () => {
    const html = renderToStaticMarkup(
      <ComposerFullscreen
        value="actually, stop"
        placeholder="输入消息"
        onCollapse={() => {}}
        running
        sendEnabled
        onStop={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain('aria-label="Send"');
  });
  it('leaves that Send inert when there is nothing to send', () => {
    const html = renderToStaticMarkup(
      <ComposerFullscreen
        value=""
        placeholder="输入消息"
        onCollapse={() => {}}
        running
        sendEnabled={false}
        onStop={() => {}}
      />,
    );
    expect(html.slice(html.indexOf('aria-label="Send"'), html.indexOf('aria-label="Stop"'))).toContain('disabled');
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
