import type { PlatformAdapter, RichBlock, ActionElement } from '@platform/index.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { recordSystemNotice } from './notice-history.js';

export type SystemNoticeLevel = 'info' | 'warning' | 'error';

export interface SystemNoticeInput {
  /** The notice body (same text that goes to the admin channel). */
  text: string;
  /** Severity — defaults to 'info'. warning/error render as resident toasts in the Web UI. */
  level?: SystemNoticeLevel;
  /** Optional short title (e.g. "Disk", "Rate limit"); the Web UI falls back to a level label. */
  title?: string;
  /** Optional platform-native content; Web notices continue to use the secret-free text fields. */
  richBlocks?: RichBlock[];
  /** Optional action buttons attached to the platform post (Slack/Feishu interactive).
   *  When present the notice is delivered via postInteractive; absent keeps postMessage. */
  actions?: ActionElement[];
}

/** Publish a `system.notice` event on the shared EventBus (the Web notification-toast source).
 *  No-op when no bus is wired (matches publishSessionMessage). */
export function publishSystemNotice(p: SystemNoticeInput): void {
  recordSystemNotice({ level: p.level ?? 'info', text: p.text, ...(p.title !== undefined ? { title: p.title } : {}) });
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
    const destination = { type: 'system-notice' } as const;
    const content = { text: p.text, ...(p.richBlocks ? { richBlocks: p.richBlocks } : {}) };
    const ref = p.actions?.length
      ? await adapter.postInteractive(destination, { ...content, actions: p.actions })
      : await adapter.postMessage(destination, content);
    return ref.conduit.length > 0;
  } catch {
    return false;
  }
}
