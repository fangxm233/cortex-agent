import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRow } from '@/features/workbench/transcript-vm';
import { MobileSessionHeader } from './MobileSessionHeader';
import { MobileMessageStream } from './MobileMessageStream';
import { MobileThreadStepper } from './MobileThreadStepper';
import { MobileApprovalCard } from './MobileApprovalCard';
import type { MobileStepper } from './mobile-session-vm';

// react-dom/server render checks for the presentational 5a components (scheme.dc.html L2932-3003).
// The wired data-binding (sessions.transcript / threads.get / approvals.list / sessions.send) is
// proven in the live harness; these lock the 1:1 chrome vs the scheme. Neutral props only (守则11).

describe('MobileSessionHeader', () => {
  const html = renderToStaticMarkup(
    <MobileSessionHeader
      initials="NO"
      title="nimbus review"
      status={{ word: 'running', turnsLabel: '12 turns', cost: '—' }}
      running
    />,
  );
  it('renders the avatar initials + title', () => {
    expect(html).toContain('NO');
    expect(html).toContain('nimbus review');
  });
  it('renders the mono status line with the dash cost placeholder', () => {
    expect(html).toContain('running');
    expect(html).toContain('12 turns');
    expect(html).toContain('—');
  });
  it('renders the ⋯ more affordance', () => {
    expect(html).toContain('⋯');
  });
});

describe('MobileMessageStream', () => {
  const rows: ChatRow[] = [
    { kind: 'divider', text: '今天 07:42' },
    { kind: 'user', text: 'how did the scan go?' },
    {
      kind: 'tools',
      count: 4,
      calls: [
        { kind: 'read', input: 'a' },
        { kind: 'threads.status', input: 'b' },
        { kind: 'grep', input: 'c' },
        { kind: 'edit', input: 'd' },
      ],
    },
    { kind: 'assistant', text: 'scan complete', streaming: true },
  ];
  const html = renderToStaticMarkup(<MobileMessageStream rows={rows} toolCallsUnit="次工具调用" />);
  it('renders the ZH divider', () => {
    expect(html).toContain('今天 07:42');
  });
  it('renders the dark user bubble text', () => {
    expect(html).toContain('how did the scan go?');
    expect(html).toContain('var(--proto-ink)');
  });
  it('renders the tool-calls count + unit + first-two chips + overflow', () => {
    expect(html).toContain('4');
    expect(html).toContain('次工具调用');
    expect(html).toContain('read');
    expect(html).toContain('threads.status');
    expect(html).toContain('+2');
  });
  it('renders the assistant text + streaming caret', () => {
    expect(html).toContain('scan complete');
    expect(html).toContain('cxblink');
  });
});

describe('MobileThreadStepper', () => {
  const card: MobileStepper = {
    name: 'experiment-pipeline',
    pillText: 'review 3/4',
    nodes: [
      { label: 'plan', state: 'done', lineDone: false },
      { label: 'execute', state: 'done', lineDone: true },
      { label: 'review', state: 'running', lineDone: true },
      { label: 'commit', state: 'pending', lineDone: false },
    ],
    footer: { elapsed: '42m', cost: '$2.31', subCount: 2 },
  };
  const html = renderToStaticMarkup(
    <MobileThreadStepper
      card={card}
      pill={{ bg: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', text: 'Running' }}
      subthreadsLabel="子线程"
      openLabel="打开"
      onOpen={() => {}}
    />,
  );
  it('renders the mono name + running pill text', () => {
    expect(html).toContain('experiment-pipeline');
    expect(html).toContain('review 3/4');
  });
  it('renders each real step label', () => {
    for (const l of ['plan', 'execute', 'review', 'commit']) expect(html).toContain(l);
  });
  it('renders the footer meta + open affordance', () => {
    expect(html).toContain('42m');
    expect(html).toContain('$2.31');
    expect(html).toContain('子线程');
    expect(html).toContain('打开');
  });
});

describe('MobileApprovalCard', () => {
  const html = renderToStaticMarkup(
    <MobileApprovalCard
      id="ap-0007"
      title="Over-budget dispatch"
      desc="Needs a large GPU window."
      needsApprovalLabel="需要审批"
      approveLabel="批准"
      denyLabel="拒绝"
      disabled={false}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );
  it('renders the amber tag + real id + title + real desc', () => {
    expect(html).toContain('需要审批');
    expect(html).toContain('ap-0007');
    expect(html).toContain('Over-budget dispatch');
    expect(html).toContain('Needs a large GPU window.');
  });
  it('renders the 批准 / 拒绝 buttons', () => {
    expect(html).toContain('批准');
    expect(html).toContain('拒绝');
  });
});
