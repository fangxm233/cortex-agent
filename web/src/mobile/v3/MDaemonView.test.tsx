// input:  daemon view model, mobile daemon copy
// output: disconnect action layout regression
// pos:    Verifies the mobile disconnect action fills its card
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MDaemonView, type MDaemonCopy } from './MDaemonView';
import type { MDaemonVm } from './m-daemon-vm';

const copy: MDaemonCopy = {
  title: 'Daemon',
  connConnected: 'connected',
  connConnecting: 'connecting',
  connReconnecting: 'reconnecting',
  connDisconnected: 'disconnected',
  threadsRunning: (n) => `${n} threads running`,
  schedules: (n) => `schedules ${n}`,
  uptimeLabel: 'uptime',
  dash: '—',
  lastRestartLabel: 'Last restart',
  recentTitle: 'Recent events',
  recentGap: 'recent gap',
  recentEmpty: 'No recent activity',
  status: {
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    stale: 'stale',
  },
  softRestart: 'Soft restart',
  forceKill: 'Force kill',
  softNote: (n) => `${n} running`,
  holdHint: 'Keep holding',
  footerNote: 'Restart note',
  sent: 'Restart sent',
  failed: 'Restart failed',
  disconnect: 'disconnect-action',
  disconnectNote: 'Disconnect note',
};

const vm: MDaemonVm = {
  ok: true,
  threadCount: 0,
  scheduleCount: 0,
  processes: [],
  lastRestart: null,
  events: [],
};

describe('MDaemonView', () => {
  it('renders the disconnect action at full card width', () => {
    const html = renderToStaticMarkup(
      <MDaemonView
        vm={vm}
        copy={copy}
        connStatus="connected"
        restartState="idle"
        showDisconnect
        onBack={() => {}}
        onSoftRestart={() => {}}
        onHardRestart={() => {}}
        onDisconnect={() => {}}
      />,
    );

    expect(html).toMatch(/<button[^>]*style="[^"]*width:100%[^"]*"[^>]*>disconnect-action<\/button>/);
  });
});
