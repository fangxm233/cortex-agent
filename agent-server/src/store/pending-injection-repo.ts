import type { EngineSelection } from '@domain/agents/engine-selection.js';
import path from 'node:path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';
import type { AttachmentMeta, SystemTurnOrigin } from '@core/types/agent-types.js';

export type PendingAttachment = AttachmentMeta;

export interface PendingInjectionRecord {
  id: string;
  sessionId: string;
  channel: string;
  messageId: string;
  backend: string;
  selection: EngineSelection | null;
  text: string;
  attachments?: PendingAttachment[];
  agentMessage?: string;
  /** Cortex authored this turn (a backgrounded agent's result, say) rather than a human. Carried
   *  here so the provisional row the UI shows before delivery already renders as a system hint —
   *  without it the full text would flash as a user bubble until the commit re-keyed the row. */
  systemOrigin?: SystemTurnOrigin;
  createdAt: string;
  /** Set when the run it went into ended without the model reading it. It then waits for the user
   *  to resend it or take it back to edit, and is never committed on its own. */
  unsentAt?: string;
}

interface PendingInjectionData {
  records: Record<string, PendingInjectionRecord>;
}

function cloneRecord(record: PendingInjectionRecord): PendingInjectionRecord {
  // Ignore retired keys in memory without rewriting persisted data.
  const current = { ...record } as PendingInjectionRecord & { sessionName?: unknown; profileName?: unknown };
  delete current.sessionName;
  delete current.profileName;
  return {
    ...current,
    selection: record.selection ? { ...record.selection } : null,
    ...(record.attachments
      ? { attachments: record.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}

export class PendingInjectionRepo {
  private readonly repo: JsonRepository<PendingInjectionData>;

  constructor(filePath = path.join(STORE_DIR, 'pending-injections.json')) {
    this.repo = new JsonRepository<PendingInjectionData>({
      filePath,
      defaultValue: () => ({ records: {} }),
    });
  }

  async add(record: PendingInjectionRecord): Promise<void> {
    await this.repo.mutate((data) => {
      data.records[record.id] = cloneRecord(record);
      return { next: data, result: undefined };
    });
  }

  async markUnsent(id: string, at: string): Promise<boolean> {
    return this.repo.mutate((data) => {
      const record = data.records[id];
      if (!record) return { next: data, result: false };
      record.unsentAt = at;
      return { next: data, result: true };
    });
  }

  /** Remove an unsent record of `sessionId` and hand it back; null when another caller took it first. */
  async takeUnsent(sessionId: string, id: string): Promise<PendingInjectionRecord | null> {
    return this.repo.mutate((data) => {
      const record = data.records[id];
      if (!record?.unsentAt || record.sessionId !== sessionId) return { next: data, result: null };
      delete data.records[id];
      return { next: data, result: cloneRecord(record) };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.repo.mutate((data) => {
      if (!data.records[id]) return { next: data, result: false };
      delete data.records[id];
      return { next: data, result: true };
    });
  }

  /** Drop every record of these sessions: a deleted session must not have its turns replayed. */
  async removeBySessionIds(sessionIds: Iterable<string>): Promise<number> {
    const drop = new Set(sessionIds);
    return this.repo.mutate((data) => {
      const ids = Object.keys(data.records).filter(id => drop.has(data.records[id].sessionId));
      for (const id of ids) delete data.records[id];
      return { next: data, result: ids.length };
    });
  }

  async listBySession(sessionId: string): Promise<PendingInjectionRecord[]> {
    return (await this.listAll()).filter((record) => record.sessionId === sessionId);
  }

  async listAll(): Promise<PendingInjectionRecord[]> {
    const data = await this.repo.read();
    return Object.values(data.records)
      .map(cloneRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const pendingInjectionRepo = new PendingInjectionRepo();
