import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MThreadDetailVm } from './m-thread-detail-vm';
import { MThreadDetailView, type MThreadDetailCopy } from './MThreadDetailView';

const copy: MThreadDetailCopy = {
  pause: '暂停',
  cancel: '取消',
  artifacts: '产物',
  noArtifacts: '暂无产物',
  pending: '待',
  depth: '深度',
  status: { running: '运行中', waiting: '等待', done: '完成', failed: '失败', cancelled: '已取消' },
};

function vm(over: Partial<MThreadDetailVm> = {}): MThreadDetailVm {
  return {
    name: 'audit-pipeline',
    tid: 'thr_c3a1',
    status: 'running',
    live: true,
    crumbs: [{ name: 'experiment-pipeline', accent: true }],
    selfLevel: 2,
    depthText: '2/5',
    metaParts: ['thr_c3a1', 'agent auditor', 'node-01'],
    elapsed: '04:12',
    cost: '$0.41',
    steps: [
      { kind: 'done', name: 'collect', note: '8 seeds · metrics/*.json', time: '2m', hasConnector: true },
      {
        kind: 'running',
        name: 'recompute',
        note: '',
        time: '02:07',
        hasConnector: true,
        agent: { turnLabel: 'turn 6 · sonnet', cost: '$0.09', lines: ['read metrics/seed.json', 'Δ success = +9.2pt'], live: true },
      },
      { kind: 'pending', name: 'report', note: '', time: '', hasConnector: false },
    ],
    artifacts: [{ filename: 'audit-report.md', meta: '2 分钟' }],
    artifactCount: 1,
    ...over,
  };
}

function render(v: MThreadDetailVm, onCancel = () => {}) {
  return renderToStaticMarkup(
    <MThreadDetailView vm={v} copy={copy} onBack={() => {}} onMore={() => {}} onCancel={onCancel} />,
  );
}

describe('MThreadDetailView', () => {
  it('renders the header: template name, status pill label, breadcrumb + self depth', () => {
    const html = render(vm());
    expect(html).toContain('audit-pipeline');
    expect(html).toContain('运行中');
    expect(html).toContain('experiment-pipeline');
    expect(html).toContain('L2');
    expect(html).toContain('深度 2/5');
  });

  it('renders the meta line (tid · agent · machine) and the accent elapsed clock', () => {
    const html = render(vm());
    expect(html).toContain('thr_c3a1');
    expect(html).toContain('agent auditor');
    expect(html).toContain('node-01');
    expect(html).toContain('04:12');
  });

  it('renders the pipeline: done note, active agent box (turn/cost/lastOutput), pending 待', () => {
    const html = render(vm());
    expect(html).toContain('collect');
    expect(html).toContain('8 seeds · metrics/*.json');
    expect(html).toContain('turn 6 · sonnet');
    expect(html).toContain('$0.09');
    expect(html).toContain('Δ success = +9.2pt');
    expect(html).toContain('report');
    expect(html).toContain('待');
  });

  it('renders the artifacts card with the real basename + rel-time and a real count', () => {
    const html = render(vm());
    expect(html).toContain('产物');
    expect(html).toContain('audit-report.md');
    expect(html).toContain('2 分钟');
  });

  it('shows the empty-artifacts placeholder when there are none (守则11 neutral)', () => {
    const html = render(vm({ artifacts: [], artifactCount: 0 }));
    expect(html).toContain('暂无产物');
  });

  it('renders the footer with 暂停 + 取消 + Σ cost when the thread is live', () => {
    const html = render(vm());
    expect(html).toContain('暂停');
    expect(html).toContain('取消');
    expect(html).toContain('Σ $0.41');
    expect(html).toContain('var(--proto-danger-bg)'); // cancel red outline
  });

  it('hides 暂停/取消 for a terminal thread but still shows Σ cost', () => {
    const html = render(vm({ live: false, status: 'completed' }));
    expect(html).not.toContain('暂停');
    expect(html).toContain('Σ $0.41');
  });

  it('wires the cancel button to the handler tag', () => {
    const onCancel = vi.fn();
    const html = renderToStaticMarkup(
      <MThreadDetailView vm={vm()} copy={copy} onBack={() => {}} onMore={() => {}} onCancel={onCancel} />,
    );
    expect(html).toContain('data-cancel-thread-id="thr_c3a1"');
  });
});
