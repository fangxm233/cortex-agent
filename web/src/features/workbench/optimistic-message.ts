// input:  local sends plus transcript, live, and server-pending user rows
// output: source-aware optimistic lifecycle and de-duplicated pending rows
// pos:    Pure Web sender reconciliation state machine
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { SessionTranscript } from '@cortex-agent/ui-contract';
import type { Attachment, LiveSessionMessage, PendingUserMessage } from './transcript-vm';

export type OptimisticTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'draft'; projectId: string };

export interface OptimisticUserMessage extends PendingUserMessage {
  clientId: string;
  target: OptimisticTarget;
  fingerprint: string;
  authorityBaselineKeys: string[];
  authorityOrdinal: number;
  phase: 'sending' | 'accepted';
}

export interface UserMessageAuthority {
  transcript: SessionTranscript;
  liveTail: LiveSessionMessage[];
  pendingUser: PendingUserMessage[];
}

interface UserOccurrence {
  fingerprint: string;
  ts: string;
  allowClockSkew: boolean;
}

export interface OptimisticReconciliation {
  pendingUser: PendingUserMessage[];
  matchedClientIds: string[];
  settledClientIds: string[];
}

export interface OptimisticMutationOptions<T> {
  message: OptimisticUserMessage;
  mutate: () => Promise<T>;
  onEnqueue: (message: OptimisticUserMessage) => void;
  onAccepted: (message: OptimisticUserMessage, data: T) => void;
  onRejected: (message: OptimisticUserMessage, error: Error) => boolean;
}

export type OptimisticMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: Error; restore: boolean };

function attachmentKey(attachment: Attachment): string {
  // createAndSend moves a draft upload into the real session directory, so path is not identity.
  return [attachment.name, attachment.size, attachment.mimeType, attachment.type].join('\u0000');
}

export function userMessageFingerprint(text: string, attachments?: Attachment[]): string {
  return JSON.stringify([text, (attachments ?? []).map(attachmentKey)]);
}

function occurrenceKey(occurrence: UserOccurrence): string {
  return `${occurrence.ts}\u0000${occurrence.fingerprint}`;
}

function addOccurrence(
  out: UserOccurrence[],
  seen: Map<string, number>,
  occurrence: UserOccurrence,
): void {
  const key = occurrenceKey(occurrence);
  const existing = seen.get(key);
  if (existing !== undefined) {
    if (occurrence.allowClockSkew) out[existing] = { ...out[existing], allowClockSkew: true };
    return;
  }
  seen.set(key, out.length);
  out.push(occurrence);
}

function committedOccurrences(source: UserMessageAuthority, sessionId: string): UserOccurrence[] {
  const out: UserOccurrence[] = [];
  const seen = new Map<string, number>();
  const push = (text: string, attachments: Attachment[] | undefined, ts: string, allowClockSkew: boolean): void => {
    addOccurrence(out, seen, { fingerprint: userMessageFingerprint(text, attachments), ts, allowClockSkew });
  };
  if (source.transcript.sessionId === sessionId) {
    for (const turn of source.transcript.turns) {
      for (const message of turn.messages) {
        if (message.type === 'user') push(message.text ?? '', message.attachments, message.ts, false);
      }
    }
  }
  for (const message of source.liveTail) {
    if (message.sessionId === sessionId && message.role === 'user') {
      push(message.text, message.attachments, message.ts, true);
    }
  }
  return out;
}

function isAtOrAfter(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) ? a >= b : left >= right;
}

const CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function isRecentAuthority(authorityTs: string, clientTs: string): boolean {
  const authority = Date.parse(authorityTs);
  const client = Date.parse(clientTs);
  if (!Number.isFinite(authority) || !Number.isFinite(client)) return authorityTs >= clientTs;
  return authority >= client - CLIENT_CLOCK_SKEW_MS;
}

function activePendingOccurrences(
  source: UserMessageAuthority,
  sessionId: string,
  committed: UserOccurrence[],
): PendingUserMessage[] {
  if (source.transcript.sessionId !== sessionId) return [];
  const available = [...committed];
  return source.pendingUser.filter((pending) => {
    const fingerprint = userMessageFingerprint(pending.text, pending.attachments);
    const index = available.findIndex((item) => item.fingerprint === fingerprint && isAtOrAfter(item.ts, pending.ts));
    if (index === -1) return true;
    available.splice(index, 1);
    return false;
  });
}

function authorityOccurrences(source: UserMessageAuthority, sessionId: string): UserOccurrence[] {
  const committed = committedOccurrences(source, sessionId);
  const pending = activePendingOccurrences(source, sessionId, committed).map((message) => ({
    fingerprint: userMessageFingerprint(message.text, message.attachments),
    ts: message.ts,
    allowClockSkew: true,
  }));
  return [...committed, ...pending];
}

function matchingAuthorityOccurrences(
  source: UserMessageAuthority,
  sessionId: string,
  fingerprint: string,
): UserOccurrence[] {
  return authorityOccurrences(source, sessionId).filter((item) => item.fingerprint === fingerprint);
}

function sameTarget(a: OptimisticTarget, b: OptimisticTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'session'
    ? a.sessionId === (b as Extract<OptimisticTarget, { kind: 'session' }>).sessionId
    : a.projectId === (b as Extract<OptimisticTarget, { kind: 'draft' }>).projectId;
}

export function createOptimisticUserMessage(
  input: { clientId: string; target: OptimisticTarget; text: string; attachments?: Attachment[]; ts: string },
  current: OptimisticUserMessage[],
  source: UserMessageAuthority,
): OptimisticUserMessage {
  const fingerprint = userMessageFingerprint(input.text, input.attachments);
  const baseline = input.target.kind === 'session'
    ? matchingAuthorityOccurrences(source, input.target.sessionId, fingerprint)
    : [];
  const prior = current.filter((item) => sameTarget(item.target, input.target) && item.fingerprint === fingerprint);
  const authorityOrdinal = Math.max(baseline.length, ...prior.map((item) => item.authorityOrdinal), 0) + 1;
  return {
    ...input,
    fingerprint,
    authorityBaselineKeys: baseline.map(occurrenceKey),
    authorityOrdinal,
    phase: 'sending',
  };
}

function promotedAttachments(attachments: Attachment[] | undefined, sessionId: string): Attachment[] | undefined {
  return attachments?.map((attachment) => ({
    ...attachment,
    path: `attachments/${sessionId}/${attachment.path.split('/').pop() || attachment.name}`,
  }));
}

export function promoteOptimisticUserMessage(
  messages: OptimisticUserMessage[],
  clientId: string,
  sessionId: string,
): OptimisticUserMessage[] {
  return messages.map((message) => message.clientId === clientId
    ? {
        ...message, target: { kind: 'session', sessionId }, phase: 'accepted',
        attachments: promotedAttachments(message.attachments, sessionId),
      }
    : message);
}

export function shouldSelectCreatedSession(
  message: OptimisticUserMessage,
  currentProjectId: string,
  draftStillActive: boolean,
): boolean {
  return draftStillActive && message.target.kind === 'draft' && message.target.projectId === currentProjectId;
}

export function acceptOptimisticUserMessage(
  messages: OptimisticUserMessage[],
  clientId: string,
): OptimisticUserMessage[] {
  return messages.map((message) => message.clientId === clientId ? { ...message, phase: 'accepted' } : message);
}

export function removeOptimisticUserMessage(
  messages: OptimisticUserMessage[],
  clientId: string,
): OptimisticUserMessage[] {
  return messages.filter((message) => message.clientId !== clientId);
}

export function resolveOptimisticRejection(
  messages: OptimisticUserMessage[],
  clientId: string,
  source: UserMessageAuthority,
): { messages: OptimisticUserMessage[]; restore: boolean } {
  const message = messages.find((item) => item.clientId === clientId);
  if (!message) return { messages, restore: false };
  if (allocatedClientIds(messages, source, false).includes(clientId)) {
    return { messages: acceptOptimisticUserMessage(messages, clientId), restore: false };
  }
  return { messages: removeOptimisticUserMessage(messages, clientId), restore: true };
}

type OccurrenceIndex = Map<string, UserOccurrence[]>;

function indexOccurrences(occurrences: UserOccurrence[]): OccurrenceIndex {
  const index: OccurrenceIndex = new Map();
  for (const occurrence of occurrences) {
    const entries = index.get(occurrence.fingerprint) ?? [];
    entries.push(occurrence);
    index.set(occurrence.fingerprint, entries);
  }
  return index;
}

function cachedOccurrences(
  cache: Map<string, OccurrenceIndex>,
  sessionId: string,
  load: (sessionId: string) => UserOccurrence[],
): OccurrenceIndex {
  const existing = cache.get(sessionId);
  if (existing) return existing;
  const loaded = indexOccurrences(load(sessionId));
  cache.set(sessionId, loaded);
  return loaded;
}

function availableOccurrence(
  message: OptimisticUserMessage,
  occurrences: UserOccurrence[],
  used: ReadonlySet<number>,
): number {
  const baseline = new Set(message.authorityBaselineKeys);
  return occurrences.findIndex((item, index) => {
    if (used.has(index) || baseline.has(occurrenceKey(item))) return false;
    return item.allowClockSkew ? isRecentAuthority(item.ts, message.ts) : isAtOrAfter(item.ts, message.ts);
  });
}

function allocatedClientIds(
  messages: OptimisticUserMessage[],
  source: UserMessageAuthority,
  committedOnly: boolean,
): string[] {
  const cache = new Map<string, OccurrenceIndex>();
  const used = new Map<string, Set<number>>();
  const matched: string[] = [];
  for (const message of messages) {
    if (message.target.kind === 'draft') continue;
    const sessionId = message.target.sessionId;
    const index = cachedOccurrences(cache, sessionId, (id) => committedOnly
      ? committedOccurrences(source, id)
      : authorityOccurrences(source, id));
    const occurrences = index.get(message.fingerprint) ?? [];
    const key = `${sessionId}\u0000${message.fingerprint}`;
    const claimed = used.get(key) ?? new Set<number>();
    const occurrence = availableOccurrence(message, occurrences, claimed);
    if (occurrence === -1) continue;
    claimed.add(occurrence);
    used.set(key, claimed);
    matched.push(message.clientId);
  }
  return matched;
}

export function hasAuthoritativeMatch(
  message: OptimisticUserMessage,
  source: UserMessageAuthority,
): boolean {
  return allocatedClientIds([message], source, false).includes(message.clientId);
}

export function reconcileOptimisticUserMessages(
  messages: OptimisticUserMessage[],
  source: UserMessageAuthority,
): OptimisticReconciliation {
  const sessionId = source.transcript.sessionId;
  const committed = committedOccurrences(source, sessionId);
  const serverPending = activePendingOccurrences(source, sessionId, committed);
  const matchedClientIds = allocatedClientIds(messages, source, false);
  const settledClientIds = allocatedClientIds(messages, source, true);
  const matched = new Set(matchedClientIds);
  const localPending = messages.filter((message) => !matched.has(message.clientId)).map((message) => ({
    id: message.clientId,
    text: message.text,
    ts: message.ts,
    attachments: message.attachments,
  }));
  return { pendingUser: [...serverPending, ...localPending], matchedClientIds, settledClientIds };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function runOptimisticMutation<T>(
  options: OptimisticMutationOptions<T>,
): Promise<OptimisticMutationResult<T>> {
  options.onEnqueue(options.message);
  try {
    const data = await options.mutate();
    options.onAccepted(options.message, data);
    return { ok: true, data };
  } catch (error) {
    const normalized = normalizeError(error);
    return { ok: false, error: normalized, restore: options.onRejected(options.message, normalized) };
  }
}
