#!/usr/bin/env node

import { writeSync, appendFileSync } from 'node:fs';
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { makeRenderStdout, newRenderStats, writesPerSecond, type RenderStats } from './render-output.js';
import { WsClient } from './ws-client.js';
import { isHandshakeAck, isSessionSwitched, isUiQueryResult, isUiEvent, isNotification } from '../platform/tui/protocol.js';
import { CORTEX_VERSION } from '../core/version.js';
import type { TuiFrame } from '../platform/tui/protocol.js';
import type { ResumableSession } from './components/SessionPicker.js';

// ── Argv parsing ──

interface TuiArgs {
  resume: boolean;
  project: string | null;
  port: number;
}

function parseArgs(argv: string[]): TuiArgs {
  const args: TuiArgs = { resume: false, project: null, port: 3003 };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--resume':
        args.resume = true;
        break;
      case '--project':
        args.project = argv[++i] ?? null;
        break;
      case '--port':
        args.port = parseInt(argv[++i] ?? '3003', 10);
        break;
    }
  }

  return args;
}

// ── Main ──

// ── Alternate-screen (fullscreen) lifecycle ──
// The TUI runs in the terminal's alternate-screen buffer so it fills the screen (like
// vim/htop) and leaves the user's scrollback untouched. It MUST be restored on every exit
// path or the user is dropped back to a blank/garbled terminal. `leaveFullscreen` is
// idempotent and writes synchronously (TTY writes are blocking on Linux, so they flush
// before the process dies).

let altScreenActive = false;
// Set once Ink has mounted; lets the signal handlers tear Ink down BEFORE leaving the
// alt-screen. Without unmounting first, Ink's own exit cleanup repaints its last frame
// onto the main buffer after the buffer switch, stranding the TUI on screen.
let inkUnmount: (() => void) | null = null;

function leaveFullscreen(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  // Leave alt-screen, show the cursor again, reset attributes, disable SGR mouse tracking
  // (?1002l/?1006l) and bracketed paste (?2004l) so the terminal isn't left reporting mouse
  // events or wrapping pastes after we exit. Use writeSync to fd 1: a buffered
  // process.stdout.write() inside an exit/signal handler is dropped before the process dies (the
  // enter sequence flushes during the run, but the leave never did), leaving the user stranded
  // on the alt buffer. writeSync bypasses the buffer.
  try { writeSync(1, '\x1b[?2004l\x1b[?1002l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[0m'); } catch { /* best effort */ }
}

/** Enter the alternate-screen buffer and register restore on EVERY exit path. */
function enterFullscreen(): void {
  if (!process.stdout.isTTY) return;
  // writeSync (unbuffered) so the switch lands on the TTY BEFORE Ink's first render — a
  // buffered process.stdout.write() can flush after Ink has already painted, leaving Ink
  // on the MAIN buffer (which then survives the leave, stranding the TUI on screen).
  // alt-screen + clear + cursor home, then enable SGR mouse tracking (?1002h button-event
  // tracking — motion events ONLY while a button is held, for drag selection; ?1006h SGR
  // encoding) so the transcript scrolls with the wheel and left-drag selects text, and
  // bracketed paste (?2004h) so multi-line pastes arrive wrapped and insert literally.
  writeSync(1, '\x1b[?1049h\x1b[2J\x1b[H\x1b[?1002h\x1b[?1006h\x1b[?2004h');
  altScreenActive = true;
  // Synchronous safety net: runs on normal exit AND on process.exit() from anywhere.
  process.on('exit', leaveFullscreen);
  // Signals that would otherwise kill us while the alt-screen is still active. SIGHUP is
  // critical: it fires when the terminal/tmux pane closes, and without handling it the
  // process was being orphaned with the alt-screen never restored.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      try { inkUnmount?.(); } catch { /* best effort */ }
      leaveFullscreen();
      process.exit(0);
    });
  }
}

// ── Render output (synchronized output + optional stats) ──
// Stage 1: wrap Ink's frame writes in DEC-2026 synchronized-update markers so the full-screen
// clear+repaint Ink emits each frame is presented atomically (no blank-flash flicker). Stage 0:
// when CORTEX_TUI_RENDER_STATS is set, also count writes/bytes/full-clears and dump a one-line
// summary to that file on exit so before/after can be compared. Disable the sync wrapping entirely
// with CORTEX_TUI_NO_SYNC=1 (escape hatch for a terminal that mis-handles 2026).
function setupRenderStdout(): { stdout: NodeJS.WriteStream | undefined } {
  if (!process.stdout.isTTY) return { stdout: undefined };
  const sync = process.env.CORTEX_TUI_NO_SYNC !== '1';
  const statsPath = process.env.CORTEX_TUI_RENDER_STATS;
  const stats: RenderStats | null = statsPath ? newRenderStats() : null;
  const stdout = makeRenderStdout(process.stdout, { sync, stats });
  if (stats && statsPath) {
    process.on('exit', () => {
      try {
        const line = `${new Date().toISOString()} sync=${sync} writes=${stats.writes} bytes=${stats.bytes} clears=${stats.clears} writes/s=${writesPerSecond(stats).toFixed(1)}\n`;
        appendFileSync(statsPath, line);
      } catch { /* best effort */ }
    });
  }
  return { stdout };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  enterFullscreen();
  const { stdout: renderStdout } = setupRenderStdout();

  const client = new WsClient();
  let dispatchFrame: ((frame: TuiFrame) => void) | null = null;
  let ackData: { conduitId: string; serverVersion: string; defaultProjectId: string } | null = null;
  let lastSessionId: string | null = null;
  let currentProjectId: string | null = null;
  let currentSessionName: string | null = null;

  // Resume state: store sessions for interactive picker
  let resumableSessions: ResumableSession[] | null = null;
  let resumePending = false;

  // Connection state
  let connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  let errorMessage: string | null = null;

  // Track rerender
  let rerender: ((node: React.ReactElement) => void) | null = null;
  let unmount: (() => void) | null = null;

  const doRender = () => {
    const app = React.createElement(App, {
      sendFrame: (frame) => client.send(frame),
      connectionState,
      ack: ackData as any,
      onReconnect: () => {
        errorMessage = null;
        connectionState = 'disconnected';
        client.close();
        doConnect();
      },
      onDisconnect: () => {
        // Tear down Ink (restores raw mode / cursor) then leave the alt-screen before
        // exiting, so the user lands back on a clean main screen.
        try { unmount?.(); } catch { /* best effort */ }
        leaveFullscreen();
        process.exit(0);
      },
      onSendCancel: () => {
        const id = `msg-${Date.now()}`;
        client.send({ type: 'msg.user', id, text: '!cancel' } as any);
      },
      serverVersion: ackData?.serverVersion ?? null,
      projectId: currentProjectId ?? ackData?.defaultProjectId ?? null,
      sessionName: currentSessionName,
      errorMessage,
      onSetDispatch: (dispatch) => { dispatchFrame = dispatch; },
      resumableSessions,
      resumePending,
      onResumeSelect: (sessionId: string, _projectId: string) => {
        resumableSessions = null;
        resumePending = false;
        client.send({
          type: 'session.switch',
          id: 'sess-resume',
          projectId: currentProjectId ?? ackData?.defaultProjectId ?? 'general',
          sessionId,
        } as any);
        doRender();
      },
      onResumeCancel: () => {
        resumableSessions = null;
        resumePending = false;
        client.send({
          type: 'session.switch',
          id: 'sess-fallback',
          projectId: currentProjectId ?? ackData?.defaultProjectId ?? 'general',
          sessionId: null,
        } as any);
        doRender();
      },
    });
    if (rerender) {
      rerender(app);
    } else {
      const instance = render(app, { exitOnCtrlC: false, ...(renderStdout ? { stdout: renderStdout } : {}) });
      rerender = instance.rerender;
      unmount = instance.unmount;
      inkUnmount = instance.unmount; // module-level ref for the signal handlers
      // Ink (via its `patchConsole`/exit handling) also restores the terminal; ensure our
      // alt-screen leave still runs after Ink fully exits.
      instance.waitUntilExit().then(leaveFullscreen).catch(() => {});
    }
  };

  const doConnect = () => {
    connectionState = 'connecting';
    doRender();

    // Set resume session before connect so auto-hello includes it
    if (lastSessionId) {
      client.markSessionId(lastSessionId);
    }

    client.connect(`ws://127.0.0.1:${args.port}`, {
      clientVersion: CORTEX_VERSION,
      project: args.project,
      onStateChange: (s) => {
        connectionState = s;
        if (s === 'connected') {
          ackData = client.ack as any;
          errorMessage = null; // clear any prior cap-exceeded error on success
        }
        doRender();
      },
      onFrame: (frame) => {
        if (isHandshakeAck(frame)) {
          ackData = {
            conduitId: frame.conduitId,
            serverVersion: frame.serverVersion,
            defaultProjectId: frame.defaultProjectId,
          };
          client.markAck(frame);
          client.markConnected();

          // Determine initial session
          const project = args.project ?? frame.defaultProjectId;
          currentProjectId = project;

          if (args.resume) {
            resumePending = true;
            client.send({
              type: 'ui.query',
              id: 'sess-list',
              scope: 'sessions.list',
              params: { resumable: true },
            } as any);
          }
          // else: do NOT send session.switch here. The server's handshake already resolved a
          // session — resuming the one carried in hello.resume (set from the last session.switched
          // on reconnect) or minting a fresh one — and emitted its session.switched. Sending
          // session.switch{ sessionId: null } would discard that and create a SECOND fresh
          // session on every (re)connect, which is why the header's session name drifted
          // (cortex-XXXXXX changing without the user switching). Just await session.switched.

          connectionState = 'connected';
          doRender();
          return;
        }

        if (isSessionSwitched(frame)) {
          lastSessionId = frame.sessionId;
          client.markSessionId(frame.sessionId);
          currentProjectId = frame.projectId;
          currentSessionName = frame.sessionName;
          resumePending = false;
          resumableSessions = null;
          doRender();
          return;
        }

        // Handle resume: ui.queryResult for sessions.list
        if (isUiQueryResult(frame) && frame.id === 'sess-list' && resumePending) {
          if (frame.ok && Array.isArray(frame.data) && frame.data.length > 0) {
            // Store sessions for interactive picker
            resumableSessions = (frame.data as any[]).map((s: any) => ({
              sessionId: s.sessionId ?? s.id,
              name: s.name,
              projectId: s.projectId,
              label: s.label ?? null,
            }));
          }
          // If no sessions, leave resumableSessions as empty array — App renders "no sessions" state
          // Then auto-fallback to fresh session
          if (!frame.ok || !Array.isArray(frame.data) || frame.data.length === 0) {
            resumePending = false;
            client.send({
              type: 'session.switch',
              id: 'sess-fallback',
              projectId: currentProjectId ?? ackData?.defaultProjectId ?? 'general',
              sessionId: null,
            } as any);
          }
          doRender();
          return;
        }

        // Dispatch frame to App for routing (transcript, dashboard, notifications).
        // The App's hooks update React state, which triggers re-render — no extra
        // doRender() here (that caused a full-tree reconcile on every stream token).
        dispatchFrame?.(frame);
      },
      onClose: (reason) => {
        connectionState = 'reconnecting';
        doRender();
      },
      onCapExceeded: () => {
        errorMessage = 'Connection failed — press R to retry, Ctrl+C to exit';
        doRender();
      },
    });
  };

  doConnect();
}

main().catch((e) => {
  try { inkUnmount?.(); } catch { /* best effort */ }
  leaveFullscreen(); // restore the main screen so the error is visible
  console.error('Fatal error:', e);
  process.exit(1);
});
