// input:  a system-notice payload (text + optional level/title) + a PlatformAdapter
// output: publishSystemNotice (bus-only) + emitSystemNotice (platform post + bus publish)
// pos:    domain/system — the single encapsulated seam for admin/system broadcasts
//         (startup, restart, profile/config/machine hot-reload, disk, rate-limit). Reads the
//         shared EventBus from the job-registry ctx (same seam session-events uses), so the
//         `system.notice` event feeds the Web notification toaster while the platform post
//         keeps delivering to the configured admin channel. Bus publish is a no-op if no bus
//         is wired; the platform post is best-effort and never throws.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '@platform/index.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';

export type SystemNoticeLevel = 'info' | 'warning' | 'error';

export interface SystemNoticeInput {
  /** The notice body (same text that goes to the admin channel). */
  text: string;
  /** Severity — defaults to 'info'. warning/error render as resident toasts in the Web UI. */
  level?: SystemNoticeLevel;
  /** Optional short title (e.g. "Disk", "Rate limit"); the Web UI falls back to a level label. */
  title?: string;
}

/** Publish a `system.notice` event on the shared EventBus (the Web notification-toast source).
 *  No-op when no bus is wired (matches publishSessionMessage). */
export function publishSystemNotice(p: SystemNoticeInput): void {
  jobCtx.bus?.publish({
    type: 'system.notice',
    level: p.level ?? 'info',
    text: p.text,
    ...(p.title !== undefined ? { title: p.title } : {}),
  });
}

/** Send a system notice through BOTH channels: publish it to the Web live stream AND post it to
 *  the platform-configured admin channel. The bus event is published first so the Web toast fires
 *  even when no admin channel is configured or the platform post fails. Returns whether the
 *  platform post succeeded. Never throws. */
export async function emitSystemNotice(
  adapter: PlatformAdapter,
  p: SystemNoticeInput,
): Promise<boolean> {
  publishSystemNotice(p);
  try {
    await adapter.postMessage({ type: 'system-notice' }, { text: p.text });
    return true;
  } catch {
    return false;
  }
}
