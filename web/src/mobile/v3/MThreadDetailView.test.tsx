// input:  live and terminal thread view models
// output: cancellation affordance visibility
// pos:    Mobile thread-detail action contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MThreadDetailVm } from './m-thread-detail-vm';
import { MThreadDetailView, type MThreadDetailCopy } from './MThreadDetailView';

const copy: MThreadDetailCopy = {
  pause: 'pause-action',
  cancel: 'cancel-action',
  artifacts: 'artifacts',
  noArtifacts: 'none',
  pending: 'pending',
  depth: 'depth',
  status: {
    running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', cancelled: 'cancelled',
  },
};

function vm(live: boolean): MThreadDetailVm {
  return {
    name: 'thread',
    tid: 'thr_contract',
    status: live ? 'running' : 'completed',
    live,
    crumbs: [],
    selfLevel: 1,
    depthText: '1/5',
    metaParts: [],
    elapsed: '0:01',
    cost: '$0.00',
    steps: [],
    artifacts: [],
    artifactCount: 0,
  };
}

function render(live: boolean): string {
  return renderToStaticMarkup(
    <MThreadDetailView
      vm={vm(live)}
      copy={copy}
      onBack={() => {}}
      onMore={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe('MThreadDetailView', () => {
  it('exposes cancellation for a live thread', () => {
    expect(render(true)).toContain('data-cancel-thread-id="thr_contract"');
  });

  it('does not expose cancellation for a terminal thread', () => {
    expect(render(false)).not.toContain('data-cancel-thread-id');
  });
});
