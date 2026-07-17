import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import {
  MChatView,
  MChatHeader,
  MChatStream,
  AskQuestionCard,
  AnsweredRow,
  PlanApprovalCard,
  ProfileSheet,
  AttachMenu,
  type MChatCopy,
} from './MChatView';
import type {
  AskQuestionCardData,
  PlanCardData,
  ProfileSheetItem,
  PendingAttachmentVM,
} from './m-chat-vm';

// Neutral fixtures only (守则11 — nimbus/atlas/orchard). The wired data-binding (sessions.transcript
// / setProfile / attachment upload) is proven in the live harness; these lock the 1:1 chrome vs the
// scheme sections 1b/1m/1n/1o/1p and the honest omit rules.

const copy: MChatCopy = {
  composerPh: '输入消息，/ 调用命令',
  toolCallsUnit: '次工具调用',
  menuRename: '重命名',
  menuExport: '导出',
  menuArchive: '归档',
  attachCamera: '拍照',
  attachLibrary: '照片图库',
  attachFile: '选择文件',
  attachFootnote: '上传完成前发送置灰 · 附件落 uploads/ 由 agent 读取',
  attachPlaceholder: '补充说明…',
  profileTitle: 'Profile',
  profileSubtitle: '仅本会话 · 热更新',
  profileCurrent: '当前',
  profileFooter: '切换仅影响本会话后续 turn',
  askPill: 'Agent 提问',
  answered: '✓ 已回答',
  defaultBadge: '默认',
  planPending: '计划待批',
  approve: '批准并执行',
  reject: '驳回并反馈',
  fromLabel: '来自',
  writeLabel: '批准写入',
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
      <MChatHeader title="nimbus review" status={{ running: true, text: 'running · 12 turns' }} onBack={() => {}} onMore={() => {}} />,
    );
    expect(html).toContain('nimbus review');
    expect(html).toContain('running · 12 turns');
    expect(html).not.toContain('$');
    expect(html).toContain('⋯');
    expect(html).toContain('cxpulse'); // running dot pulses
  });
  it('renders an idle status line without a pulse', () => {
    const html = renderToStaticMarkup(
      <MChatHeader title="atlas" status={{ running: false, text: 'idle · 3 turns' }} onBack={() => {}} onMore={() => {}} />,
    );
    expect(html).toContain('idle · 3 turns');
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
    expect(html).toContain('#191C22');
    expect(html).toContain('次工具调用');
    expect(html).toContain('read');
    expect(html).toContain('+2'); // 4 calls, first-two chips + overflow
    expect(html).toContain('scan complete');
    // The blue blinking output-position block was removed by request.
    expect(html).not.toContain('cxblink');
  });
});

describe('interaction entity rows in the stream (web-interactions-redesign)', () => {
  it('renders a pending plan interaction row as an actionable approval card', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'plan-pending', text: 'Plan submitted for approval',
      detail: { id: 'req-1', kind: 'plan-approval', status: 'pending', payload: { planContent: '# DR sweep plan\nstep one', planFilePath: 'plan/x.md' } },
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" copy={copy} />);
    expect(html).toContain('计划待批');
    expect(html).toContain('# DR sweep plan');
    expect(html).toContain('批准并执行');
    expect(html).toContain('plan/x.md');
  });
  it('renders a pending ask-user interaction row as an actionable question card', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'ask-user-pending', text: 'A or B?',
      detail: { id: 'req-2', kind: 'ask-user', status: 'pending', payload: { questions: [{ question: 'A or B?', header: 'Q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } },
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" copy={copy} />);
    expect(html).toContain('Agent 提问');
    expect(html).toContain('A or B?');
    expect(html).toContain('默认');
  });
  it('renders an expired interaction row as a grayed inactive summary (no buttons)', () => {
    const rows: ChatRow[] = [{
      kind: 'interaction', subtype: 'plan-expired', text: 'Plan approval expired',
      detail: { id: 'req-3', kind: 'plan-approval', status: 'expired', payload: { planContent: '# P', planFilePath: null } },
    }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" copy={copy} />);
    expect(html).toContain('Plan approval expired');
    expect(html).not.toContain('批准并执行');
  });
  it('renders a legacy interaction row (no detail) as the old summary', () => {
    const rows: ChatRow[] = [{ kind: 'interaction', subtype: 'plan-approved', text: 'Plan approved' }];
    const html = renderToStaticMarkup(<MChatStream rows={rows} toolCallsUnit="次" copy={copy} />);
    expect(html).toContain('Plan approved');
  });
});

describe('1o attachments in the stream', () => {
  it('renders sent attachments above the user bubble', () => {
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
  });
});

describe('1m AskQuestionCard', () => {
  const data: AskQuestionCardData = {
    id: 'APQ-0003',
    question: '扫描 seed 规模用哪组？',
    ttlLabel: '29:14 后按默认继续',
    options: [
      { id: 'a', label: '8 seeds — 复用 nimbus 配置', isDefault: true },
      { id: 'b', label: '16 seeds — 置信更高', isDefault: false, meta: '+$4.20 · +38m' },
    ],
    source: 'atlas › plan',
    syncedNote: 'hook 已同步 Slack',
  };
  const html = renderToStaticMarkup(<AskQuestionCard data={data} copy={copy} onAnswer={() => {}} />);
  it('renders the pill, id, TTL, question, options with 默认 badge + meta, and source footer', () => {
    expect(html).toContain('Agent 提问');
    expect(html).toContain('APQ-0003');
    expect(html).toContain('29:14 后按默认继续');
    expect(html).toContain('扫描 seed 规模用哪组？');
    expect(html).toContain('8 seeds — 复用 nimbus 配置');
    expect(html).toContain('默认');
    expect(html).toContain('+$4.20 · +38m');
    expect(html).toContain('atlas › plan');
    expect(html).toContain('hook 已同步 Slack');
    expect(html).toContain('min-height:44px'); // ≥44px tap targets
  });
  it('OMITS the TTL when the interaction carries no deadline (honest gap)', () => {
    const html2 = renderToStaticMarkup(<AskQuestionCard data={{ ...data, ttlLabel: null }} copy={copy} onAnswer={() => {}} />);
    expect(html2).not.toContain('后按默认继续');
  });
  it('collapses an already-answered question', () => {
    const h = renderToStaticMarkup(<AnsweredRow row={{ id: 'q1', summary: '用哪个 checkpoint？→ ckpt-a', time: '07:12' }} copy={copy} />);
    expect(h).toContain('✓ 已回答');
    expect(h).toContain('用哪个 checkpoint？→ ckpt-a');
    expect(h).toContain('07:12');
  });
});

describe('1n PlanApprovalCard', () => {
  const data: PlanCardData = {
    title: 'DR 扫描 — friction ∈ [0.6, 1.2] × 8 seeds',
    estimateLabel: '预估 $3.80 · ~55m',
    steps: [
      { n: 1, text: '生成 8 组域随机化配置', dur: '2m' },
      { n: 2, text: 'dispatch 到 gpu-01', dur: '35m' },
    ],
    note: '不含真机部署',
    writePath: 'plans/nimbus-plan.md',
  };
  const html = renderToStaticMarkup(<PlanApprovalCard data={data} copy={copy} onApprove={() => {}} onReject={() => {}} />);
  it('renders the pill, ExitPlanMode, estimate, numbered steps, note, buttons, write path', () => {
    expect(html).toContain('计划待批');
    expect(html).toContain('ExitPlanMode');
    expect(html).toContain('预估 $3.80 · ~55m');
    expect(html).toContain('生成 8 组域随机化配置');
    expect(html).toContain('2m');
    expect(html).toContain('批准并执行');
    expect(html).toContain('驳回并反馈');
    expect(html).toContain('不含真机部署');
    expect(html).toContain('plans/nimbus-plan.md');
  });
  it('OMITS the estimate when the plan carries none (honest gap)', () => {
    const h = renderToStaticMarkup(<PlanApprovalCard data={{ ...data, estimateLabel: null }} copy={copy} onApprove={() => {}} onReject={() => {}} />);
    expect(h).not.toContain('预估');
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
        status={{ running: true, text: 'running · 2m 4s · 5 turns' }}
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
        status={{ running: true, text: 'running · 12 turns' }}
        rows={[]}
        onStop={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Send"');
  });
  it('shows the Send button (not Stop) when idle', () => {
    const html = renderToStaticMarkup(
      <MChatView {...baseProps} status={{ running: false, text: 'idle' }} rows={[]} />,
    );
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop"');
  });
  it('shows the attachment footnote + placeholder when uploads are present', () => {
    const html = renderToStaticMarkup(
      <MChatView
        {...baseProps}
        status={{ running: false, text: 'idle' }}
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
