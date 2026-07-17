// input:  src/tui/components/Dashboard.js
// output: Regression — the per-tab query/subscribe effect must not re-fire on every
//         render when the parent passes fresh callback / sendFrame identities.
// pos:    Guards the Ctrl+D render-storm bug (unstable App callbacks → effect re-runs
//         every render → setState → infinite loop / 95% CPU). Deterministic: drives a
//         bounded number of re-renders with fresh identities rather than the live loop
//         (which would starve the event loop and hang the suite).

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Dashboard } from '../../src/tui/components/Dashboard.js';
import { EMPTY_DASH_STATE } from '../../src/tui/hooks/useDashboardData.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('dashboard tab does not re-subscribe/re-query when caller passes unstable callbacks', async () => {
  const sent: any[] = [];

  // Every render creates brand-new callback + sendFrame identities — exactly what
  // App did before the fix (useCallback keyed on the fresh useDashboardData object).
  function Harness() {
    return React.createElement(Dashboard as any, {
      active: false,
      sendFrame: (f: any) => sent.push(f),
      projectId: 'general',
      dashState: EMPTY_DASH_STATE,
      onMarkPending: () => {},
      onRegisterSubscription: () => {},
      onUnregisterSubscription: () => {},
      activeTab: 'threads',
      onSetActiveTab: () => {},
      mutate: async () => ({ ok: true }),
    });
  }

  const instance = render(React.createElement(Harness));
  await delay(120);

  const countQueries = () =>
    sent.filter(f => f && f.type === 'ui.query' && f.scope === 'threads.list').length;

  const afterMount = countQueries();
  assert.equal(afterMount, 1, `expected exactly one initial query, got ${afterMount}`);

  // Force several re-renders with fresh callback identities.
  for (let i = 0; i < 6; i++) {
    instance.rerender(React.createElement(Harness));
    await delay(20);
  }

  const total = countQueries();
  assert.ok(
    total <= 1,
    `threads.list query re-fired on re-render (${total} total) — the per-tab effect ` +
      `depends on unstable callback identities and will infinite-loop in App`,
  );

  instance.unmount();
  instance.cleanup();
});
