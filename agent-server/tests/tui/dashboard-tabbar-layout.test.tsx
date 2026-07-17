// input:  src/tui/components/SidePanel.js
// output: Regression — dashboard tab labels must render intact inside the side panel width
// pos:    Guards the narrow-panel tab-label wrapping bug ("Execu/tions")

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { SidePanel } from '../../src/tui/components/SidePanel.js';
import { EMPTY_DASH_STATE } from '../../src/tui/hooks/useDashboardData.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('dashboard tab labels render intact inside the side panel', async () => {
  const instance = render(
    React.createElement(SidePanel as any, {
      visible: true,
      active: false,
      sendFrame: () => {},
      projectId: 'general',
      dashState: EMPTY_DASH_STATE,
      onMarkPending: () => {},
      onRegisterSubscription: () => {},
      onUnregisterSubscription: () => {},
      activeTab: 'threads',
      onSetActiveTab: () => {},
      onMutate: async () => ({ ok: true }),
    }),
  );
  await delay(120);

  const frame = instance.lastFrame() ?? '';
  for (const label of ['Threads', 'Tasks', 'Schedules', 'Executions', 'Cost']) {
    assert.ok(
      frame.includes(label),
      `tab label "${label}" should render on a single line, not wrapped — frame:\n${frame}`,
    );
  }

  instance.unmount();
  instance.cleanup();
});
