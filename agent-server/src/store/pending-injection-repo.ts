// input:  pending injection records + JsonRepository
// output: PendingInjectionRepo and process-wide singleton
// pos:    durable active-state store for unconsumed injected messages
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import path from 'node:path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

export interface PendingAttachment {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  type: 'image' | 'video' | 'file';
}

export interface PendingInjectionRecord {
  id: string;
  sessionId: string;
  channel: string;
  messageId: string;
  sessionName: string | null;
  backend: string;
  profileName: string | null;
  text: string;
  attachments?: PendingAttachment[];
  agentMessage?: string;
  createdAt: string;
}

interface PendingInjectionData {
  records: Record<string, PendingInjectionRecord>;
}

function cloneRecord(record: PendingInjectionRecord): PendingInjectionRecord {
  return {
    ...record,
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

  async remove(id: string): Promise<boolean> {
    return this.repo.mutate((data) => {
      if (!data.records[id]) return { next: data, result: false };
      delete data.records[id];
      return { next: data, result: true };
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
