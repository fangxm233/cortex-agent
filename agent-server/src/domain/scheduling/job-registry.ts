import type { EventBus } from '@events/index.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';

/** Say one thing on a destination. For a schedule whose session could not be opened — nothing ran,
 *  so there is no transcript to write on. Durable when an outbound queue exists. */
export type NotifyDestination = (destination: Destination, text: string) => Promise<void>;

/** Open a scheduled run: deliver the fired prompt into its freshly created session as that
 *  session's first turn. Resolves once the turn is admitted, not when it ends. */
export type DeliverScheduledTurn = (input: { channel: string; text: string }) => Promise<void>;

// Shared context set by runner.ts / app.ts after init
export const ctx: {
  /** Read only by auth-expiry-scan / sync-public. */
  adapter: PlatformAdapter | null;
  bus: EventBus | null;
  notify: NotifyDestination | null;
  deliverScheduledTurn: DeliverScheduledTurn | null;
} = {
  adapter: null,
  bus: null,
  notify: null,
  deliverScheduledTurn: null,
};

/** Read one injected collaborator, or say plainly which wiring is missing. A job that reaches
 *  orchestration through an un-injected seam is a composition-root bug, not a runtime condition —
 *  it must not degrade into a silently skipped run. */
export function requireJobCtx<K extends 'notify' | 'deliverScheduledTurn'>(name: K): NonNullable<typeof ctx[K]> {
  const value = ctx[name];
  if (!value) throw new Error(`job ctx: ${name} not injected`);
  return value as NonNullable<typeof ctx[K]>;
}
