// input:  PlatformAdapter, notice payload, shared job context
// output: Web event publication and best-effort platform delivery
// pos:    Domain seam for admin and system broadcasts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
    const ref = await adapter.postMessage({ type: 'system-notice' }, { text: p.text });
    return ref.conduit.length > 0;
  } catch {
    return false;
  }
}
