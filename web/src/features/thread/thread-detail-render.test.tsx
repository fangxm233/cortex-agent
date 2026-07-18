import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}
import { ThreadPipeline } from './ThreadPipeline';
import { ThreadArtifactPanel } from './ThreadArtifactPanel';
import type { DetailArtifact, ThreadDetailVm } from './thread-detail-vm';

// react-dom/server render checks for the 11b presentational surface (design §6.3 F2). vitest runs in
// node; browser E2E is environment-blocked (persistent SSE defeats headless-Chrome — see
// features/thread/CORTEX.md), so these assert the real components' markup. Data fetching + cancel/
// drill navigation live in ThreadDetailRoute/View (verified against a real ui-http-server, not here).

const runningVm: ThreadDetailVm = {
  name: 'plan-exec-review',
  tid: 'thr_8f2c',
  pill: { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)', text: 'Running' },
  crumbs: [{ id: null, name: 'quad-nav-sim2real', accent: false }],
  template: 'plan-exec-review',
  started: '07:12',
  elapsed: '42:18',
  cost: 'Σ $2.52',
  task: 'T-041',
  depthDots: [true, true, false, false, false].map((filled) => ({ filled })),
  depthText: '2/5',
  live: true,
  steps: [
    { kind: 'done', title: '1 · Plan', note: 'plan.md', meta: '3m · $0.04', hasConnector: false, subs: [], subCount: 0, stepIndex: 0, sessionId: 'cortex-plan', sessionName: 'cortex-plan', profile: 'planner' },
    {
      kind: 'running',
      title: '3 · Review',
      note: '',
      meta: '04:12',
      hasConnector: true,
      stepIndex: 2,
      sessionId: 'cortex-review',
      sessionName: 'cortex-review',
      profile: 'reviewer',
      agent: {
        profile: 'reviewer',
        execInfo: 'exec_31b0 · local',
        lastOutput: 'Now checking the headline claim.',
        streaming: true,
        live: true,
      },
      subCount: 3,
      subs: [
        // running + drillable → line + `open ›`
        { id: 'thr_b7f3', name: 'verify-metrics', level: 'L2', pill: { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)', text: 'Running' }, hasLine: true, line: 'analyst', isMax: false, drillable: true },
        // terminal (no agent line) BUT drillable → `open ›` only, no line (the decoupled-drill case)
        { id: 'thr_done', name: 'sub-audit', level: 'L2', pill: { bg: 'var(--proto-success-bg)', fg: 'var(--proto-success)', text: 'Done' }, hasLine: false, line: '', isMax: false, drillable: true },
        // terminal leaf, no subtree → NO `open ›` (matches proto-shot 04 check-claims)
        { id: 'thr_cc', name: 'check-claims', level: 'L2', pill: { bg: 'var(--proto-success-bg)', fg: 'var(--proto-success)', text: 'Done' }, hasLine: false, line: '', isMax: false, drillable: false },
      ],
    },
    { kind: 'pending', title: '4 · Commit', note: 'safety class: repo write', meta: 'gated', hasConnector: true, subs: [], subCount: 0, stepIndex: 3, sessionId: null, sessionName: null, profile: 'slot-3' },
  ],
  artifact: {} as DetailArtifact,
};

describe('ThreadPipeline', () => {
  // The step chat is data-bound (tRPC/query); inject a static stub so the presentational pipeline can
  // be asserted in a node static render. It echoes the sessionId + live flag it was handed.
  const html = renderToStaticMarkup(
    <ThreadPipeline
      vm={runningVm}
      onOpenSub={() => {}}
      renderStepChat={(sessionId, live) => `CHAT[${sessionId ?? 'none'}|${live ? 'live' : 'static'}]`}
    />,
  );
  it('renders the PIPELINE header + hint', () => {
    expect(html).toContain('PIPELINE');
    expect(html).toContain('click a step to expand');
  });
  it('renders each step title and the collapsed metas', () => {
    expect(html).toContain('1 · Plan');
    expect(html).toContain('3 · Review');
    expect(html).toContain('4 · Commit');
    expect(html).toContain('gated');
  });
  it('expands the running step into the agent chat + sub-thread cards', () => {
    expect(html).toContain('agent: reviewer');
    expect(html).toContain('exec_31b0 · local');
    // the running step is expanded by default → its chat renders live off its own session
    expect(html).toContain('CHAT[cortex-review|live]');
    expect(html).toContain('SUB-THREADS · 3');
    expect(html).toContain('verify-metrics');
    expect(html).toContain('sub-audit');
    expect(html).toContain('check-claims');
  });
  it('renders `open ›` for EVERY drillable sub-thread (incl. terminal-with-subtree), not the leaf', () => {
    // both drillable subs render a drill link; the childless leaf does not → exactly 2 links.
    expect(html.match(/data-drill-thread-id/g) ?? []).toHaveLength(2);
    expect(html).toContain('data-drill-thread-id="thr_b7f3"');
    expect(html).toContain('data-drill-thread-id="thr_done"'); // terminal + drillable
    expect(html).not.toContain('data-drill-thread-id="thr_cc"'); // childless leaf → no drill
  });
});

describe('ThreadArtifactPanel', () => {
  const artifact: DetailArtifact = {
    path: 'experiments/domain-rand-sweep.md',
    live: true,
    updated: '2m ago',
    taskId: 'T-041',
    taskProject: 'quad-nav-sim2real',
    workspacePath: '/ws/thr_8f2c',
    writtenBy: [
      { label: '1 Plan · done', active: false },
      { label: '3 Review · editing', active: true },
    ],
    contentGap: true,
  };
  const html = renderToStaticMarkup(<ThreadArtifactPanel artifact={artifact} onOpen={() => {}} />);
  it('renders the header refs + live badge + Open', () => {
    expect(html).toContain('THREAD ARTIFACT');
    expect(html).toContain('experiments/domain-rand-sweep.md');
    expect(html).toContain('live');
    expect(html).toContain('Open ↗');
    expect(html).toContain('2m ago');
  });
  it('renders REFERENCES from real refs and the Stage-6 content-gap note', () => {
    expect(html).toContain('REFERENCES');
    expect(html).toContain('/ws/thr_8f2c');
    expect(html).toContain('quad-nav-sim2real');
    expect(html).toContain('Memory viewer');
  });
  it('renders WRITTEN BY chips from steps', () => {
    expect(html).toContain('WRITTEN BY');
    expect(html).toContain('1 Plan · done');
    expect(html).toContain('3 Review · editing');
  });
});
