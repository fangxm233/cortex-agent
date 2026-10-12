//
// A lead's unread routine updates. A worker turn marked routine does not wake its lead; its reply
// goes into the lead's inbox instead and is given to the lead the next time it hears anything —
// appended to a delivered worker report or question, or added to the [Team] block of its next
// turn — after which it is read.

import { teamInboxRepo, type TeamInboxRepo, type TeamInboxWorker } from '@store/team-inbox-repo.js';

/** First line of the section. Chat surfaces strip from this line to the end of the message, so it
 *  must stay last and keep this exact text. */
export const UNREAD_DIGEST_HEADER = '[Unread routine updates]';

const LINE_MAX = 200;

/** The line an update is listed under: the reply's first non-empty line, capped. */
export function inboxLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:MM` today, `MM-DD HH:MM` on any other day (server local time). */
function stamp(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return today ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** The unread section, or '' when there is nothing unread. */
export function formatUnreadDigest(workers: readonly TeamInboxWorker[], now: number): string {
  if (workers.length === 0) return '';
  const lines = [UNREAD_DIGEST_HEADER];
  for (const w of workers) {
    lines.push(w.dropped > 0 ? `${w.name} (${w.dropped} older not shown):` : `${w.name}:`);
    for (const item of w.items) lines.push(`- ${stamp(item.at, now)} ${item.text}`);
  }
  return lines.join('\n');
}

/**
 * Take a lead's unread updates as a digest, marking them read. `restore` puts them back for a
 * caller whose message never reached the lead.
 */
export async function takeUnreadDigest(
  leadId: string,
  inbox: Pick<TeamInboxRepo, 'take' | 'restore'> = teamInboxRepo,
  now: number = Date.now(),
): Promise<{ text: string; restore: () => Promise<void> }> {
  const workers = await inbox.take(leadId);
  return { text: formatUnreadDigest(workers, now), restore: () => inbox.restore(leadId, workers) };
}

/** A delivered message with the unread section appended last. */
export function withDigest(text: string, digest: string): string {
  return digest ? `${text}\n\n${digest}` : text;
}
