// input:  ConversationHistoryRepo (persistence) + EventBus (notification)
// output: InteractionRecords singleton — the persistent interaction entity service
//         (ask-user question / plan approval as first-class records with a status machine)
// pos:    orch/interactions/ — single source of truth for web-conduit interaction state
//         (web-interactions-redesign plan). The in-memory index doubles as the liveness
//         signal: after a restart the index is empty, so readers derive still-`pending`
//         JSONL records to `expired` — no startup scan needed.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import type { EventBus } from '@events/index.js';
import type {
  ConversationHistoryRepo,
  InteractionKind,
  InteractionStatus,
  InteractionPayload,
  InteractionResult,
  InteractionResolvedVia,
} from '../../store/conversation-history-repo.js';

const log = createLogger('interaction-records');

/** Shared pending TTL — matches hook-bridge / ask-user TTLs (30 minutes). */
export const INTERACTION_TTL_MS = 30 * 60 * 1000;

/** Terminal index entries are pruned after this age (bounded memory). */
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;

export interface InteractionIndexEntry {
  id: string;
  sessionId: string;
  channel: string;
  kind: InteractionKind;
  status: InteractionStatus;
  payload: InteractionPayload;
  createdAt: number;
}

interface HistoryDep {
  appendInteractionCreated: ConversationHistoryRepo['appendInteractionCreated'];
  appendInteractionResolved: ConversationHistoryRepo['appendInteractionResolved'];
}

// ── Human-readable summaries (persisted `text`, shown by legacy clients / TUI replay) ──

export function buildCreatedText(kind: InteractionKind, payload: InteractionPayload): string {
  if (kind === 'ask-user') {
    const qs = payload.questions ?? [];
    return qs.length ? qs.map((q) => q.question).join('\n') : 'Question';
  }
  return 'Plan submitted for approval';
}

export function buildResolvedText(kind: InteractionKind, status: InteractionStatus, result?: InteractionResult): string {
  if (status === 'expired') return kind === 'plan-approval' ? 'Plan approval expired' : 'Question expired';
  if (status === 'cancelled') return kind === 'plan-approval' ? 'Plan approval cancelled' : 'Question cancelled';
  if (kind === 'ask-user') {
    const answers = result?.answers ?? {};
    const parts = Object.entries(answers).map(([q, a]) => `${q} → ${a}`);
    return parts.length ? parts.join('\n') : 'Question answered';
  }
  if (status === 'approved') return 'Plan approved';
  return result?.feedback ? `Plan rejected: ${result.feedback}` : 'Plan rejected';
}

/** Legacy-compatible subtype for display (old clients render InteractionRow off this). */
export function deriveSubtype(kind: InteractionKind, status: InteractionStatus): string {
  if (kind === 'plan-approval') {
    if (status === 'approved') return 'plan-approved';
    if (status === 'rejected') return 'plan-rejected';
    return `plan-${status}`;
  }
  if (status === 'answered') return 'ask-user-answered';
  return `ask-user-${status}`;
}

export class InteractionRecords {
  private index = new Map<string, InteractionIndexEntry>();
  private history: HistoryDep | null = null;
  private bus: EventBus | null = null;

  /** Called once from app.ts during startup. */
  init(deps: { history: HistoryDep; bus: EventBus }): void {
    this.history = deps.history;
    this.bus = deps.bus;
  }

  /** Register + persist a new pending interaction, then broadcast its arrival. */
  async create(args: { id: string; sessionId: string; channel: string; kind: InteractionKind; payload: InteractionPayload }): Promise<void> {
    if (!this.history || !this.bus) {
      log.error('interaction-records not initialised; dropping create for ' + args.id);
      return;
    }
    this.prune();
    const entry: InteractionIndexEntry = {
      id: args.id,
      sessionId: args.sessionId,
      channel: args.channel,
      kind: args.kind,
      status: 'pending',
      payload: args.payload,
      createdAt: Date.now(),
    };
    this.index.set(args.id, entry);
    await this.history.appendInteractionCreated(args.sessionId, {
      id: args.id,
      kind: args.kind,
      payload: args.payload,
      text: buildCreatedText(args.kind, args.payload),
    });
    this.publish(entry);
  }

  /** Move a pending interaction to a terminal status. First-writer-wins. */
  async resolve(args: { id: string; status: Exclude<InteractionStatus, 'pending'>; result?: InteractionResult; resolvedVia: InteractionResolvedVia }): Promise<'resolved' | 'already-resolved' | 'unknown'> {
    const entry = this.index.get(args.id);
    if (!entry) return 'unknown';
    if (entry.status !== 'pending') return 'already-resolved';
    if (!this.history || !this.bus) return 'unknown';
    entry.status = args.status;
    await this.history.appendInteractionResolved(entry.sessionId, {
      id: args.id,
      status: args.status,
      result: args.result,
      resolvedVia: args.resolvedVia,
      text: buildResolvedText(entry.kind, args.status, args.result),
    });
    this.publish(entry);
    return 'resolved';
  }

  /** Resolve every pending interaction on a channel (e.g. `!new` → cancelled). */
  async resolvePendingByChannel(channel: string, status: Exclude<InteractionStatus, 'pending'>, resolvedVia: InteractionResolvedVia): Promise<number> {
    let count = 0;
    for (const entry of this.index.values()) {
      if (entry.channel === channel && entry.status === 'pending') {
        const out = await this.resolve({ id: entry.id, status, resolvedVia });
        if (out === 'resolved') count++;
      }
    }
    return count;
  }

  get(id: string): InteractionIndexEntry | null {
    return this.index.get(id) ?? null;
  }

  /** Liveness signal for read-time derivation: true only for a live, un-expired pending entry. */
  isPending(id: string): boolean {
    const entry = this.index.get(id);
    return !!entry && entry.status === 'pending' && Date.now() - entry.createdAt <= INTERACTION_TTL_MS;
  }

  /** All live pending interactions for a channel (payload included, TTL-filtered). */
  getPendingByChannel(channel: string): InteractionIndexEntry[] {
    const out: InteractionIndexEntry[] = [];
    for (const entry of this.index.values()) {
      if (entry.channel === channel && entry.status === 'pending' && Date.now() - entry.createdAt <= INTERACTION_TTL_MS) {
        out.push(entry);
      }
    }
    return out;
  }

  private publish(entry: InteractionIndexEntry): void {
    this.bus?.publish({
      type: 'session.interaction',
      sessionId: entry.sessionId,
      channel: entry.channel,
      interactionId: entry.id,
      kind: entry.kind,
      status: entry.status,
    });
  }

  /** Drop terminal entries older than the retention window (bounded memory). */
  private prune(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const [id, entry] of this.index) {
      if (entry.status !== 'pending' && entry.createdAt < cutoff) this.index.delete(id);
    }
  }

  _testReset(): void {
    this.index.clear();
  }
}

export const interactionRecords = new InteractionRecords();
