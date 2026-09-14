import type { TuiConnection } from './tui-connection.js';
import { createLogger } from '@core/log.js';
import type { MessageRef } from '../../types.js';

const log = createLogger('tui-notif');

/**
 * Send a project-report notification to all connections. Connections whose active
 * session matches the source session get chat.post (inline); all others get a
 * notification frame (including cross-project connections).
 */
export function sendProjectReport(
  connections: TuiConnection[],
  projectId: string,
  sourceSessionId: string,
  title: string,
  body: string,
  ref?: MessageRef,
): void {
  let sent = 0;
  for (const conn of connections) {
    if (conn.activeSessionId === sourceSessionId) {
      // Render as chat.post in the active session
      const seq = 0;
      conn.send({
        type: 'chat.post',
        ref: ref ?? { conduit: conn.conduitId, messageId: '', threadId: null },
        content: { text: `${title}\n${body}` },
        seq,
      });
    } else {
      // Render as notification
      const seq = 0;
      conn.send({
        type: 'notification',
        kind: 'project-report',
        projectId,
        sessionId: sourceSessionId,
        title,
        body,
        ref,
        seq,
      });
    }
    sent++;
  }
  if (sent === 0) {
    log.warn(`No TUI connections matched project "${projectId}" for project-report`);
  }
}

/**
 * Send a system-notice to all TUI connections.
 */
export function sendSystemNotice(
  connections: TuiConnection[],
  title: string,
  body: string,
): void {
  for (const conn of connections) {
    const seq = 0;
    conn.send({
      type: 'notification',
      kind: 'system-notice',
      projectId: conn.activeProjectId,
      title,
      body,
      seq,
    });
  }
}
