// Pure view-model for DM-message notifications (design 18a). Framework-agnostic and
// deterministic so it can be unit-tested without a DOM — the React glue
// (`useDmNotifications` + `NotificationToaster`) delegates all shaping here.
//
// A "DM message" is an assistant message Cortex posts in a user's direct chat session
// (origin='direct'); the workbench streams these as `session.message` events. This module
// turns one such event into the toast's on-screen shape.

export type NotificationLevel = 'info' | 'warning' | 'error';

/** One notification bubble (scheme 18a). */
export interface NotificationItem {
  id: string;
  level: NotificationLevel;
  /** Bold ink title — the conversation the message came from (session label/name). */
  title: string;
  /** One-line mono metadata preview of the message body. */
  meta: string;
  /** ISO-8601 timestamp the message was posted. */
  ts: string;
  /** The direct session this message belongs to (for click-through navigation). */
  sessionId: string;
  /** The project the session belongs to; null when unknown (honest, not fabricated). */
  projectId: string | null;
}

/** Max characters shown in the mono preview line before ellipsis (single-line bubble). */
export const PREVIEW_MAX = 96;

/** Collapse whitespace and clip to `max` chars with a trailing ellipsis. */
export function previewText(text: string, max = PREVIEW_MAX): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + '…';
}

export interface BuildNotificationInput {
  id: string;
  sessionId: string;
  /** Session label/name for the title; null/empty falls back to a generic title. */
  sessionName: string | null;
  projectId: string | null;
  /** The assistant message body. */
  text: string;
  ts?: string;
  /** Explicit severity; DM chat replies are always 'info' (no severity guessing / fabrication). */
  level?: NotificationLevel;
}

/** Shape a session-message event into a NotificationItem. Title = conversation name, meta =
 *  a one-line preview of the message body. Level defaults to 'info' — the honest level for a
 *  chat reply; warning/error are reserved for future server-classified notification events. */
export function buildNotification(input: BuildNotificationInput): NotificationItem {
  const name = (input.sessionName ?? '').trim();
  return {
    id: input.id,
    level: input.level ?? 'info',
    title: name || 'New message',
    meta: previewText(input.text),
    ts: input.ts ?? new Date().toISOString(),
    sessionId: input.sessionId,
    projectId: input.projectId,
  };
}

/** Whether a level auto-dismisses (info) or stays resident until dismissed (warning/error).
 *  Scheme 18a 两级停留: info 6s auto; warning/error 常驻. */
export function isTransient(level: NotificationLevel): boolean {
  return level === 'info';
}

/** Auto-dismiss duration (ms) for transient notifications (scheme 18a: info 6s). */
export const AUTO_DISMISS_MS = 6000;
