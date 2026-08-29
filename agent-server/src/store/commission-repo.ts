// input:  JsonRepository, STORE_DIR
// output: CommissionRepo + CommissionRecord types
// pos:    Commission (long-task) registry persistence store
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

export const COMMISSIONS_FILE = path.join(STORE_DIR, 'commissions.json');

export type CommissionStatus = 'active' | 'done' | 'abandoned';

/** One approved commission (DR-0037). Draft dirs (`commissions/_draft-*`) are NOT registered —
 *  a record exists only after the contract passed the commission plan-exit approval. Gate state
 *  is derived from member sessions' awaitingInput, never stored here. */
export interface CommissionRecord {
  id: string;            // 8-hex
  projectId: string;
  slug: string;          // final directory name under <contextDir>/commissions/
  title: string;
  status: CommissionStatus;
  createdAt: number;     // approval time
  updatedAt: number;
  closedAt?: number;
  closeNote?: string;
}

export interface CommissionsData {
  commissions: CommissionRecord[];
}

function defaultData(): CommissionsData {
  return { commissions: [] };
}

function migrate(raw: unknown): CommissionsData {
  if (typeof raw !== 'object' || raw === null || !('commissions' in raw)) return defaultData();
  return raw as CommissionsData;
}

export function newCommissionId(): string {
  return randomBytes(4).toString('hex');
}

export class CommissionRepo {
  private _repo: JsonRepository<CommissionsData>;

  constructor(filePath: string = COMMISSIONS_FILE) {
    this._repo = new JsonRepository<CommissionsData>({ filePath, defaultValue: defaultData, migrate });
  }

  async list(projectId?: string): Promise<CommissionRecord[]> {
    const data = await this._repo.read();
    const all = projectId === undefined
      ? data.commissions
      : data.commissions.filter(c => c.projectId === projectId);
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async find(id: string): Promise<CommissionRecord | null> {
    const data = await this._repo.read();
    return data.commissions.find(c => c.id === id) ?? null;
  }

  async findBySlug(projectId: string, slug: string): Promise<CommissionRecord | null> {
    const data = await this._repo.read();
    return data.commissions.find(c => c.projectId === projectId && c.slug === slug) ?? null;
  }

  async add(record: CommissionRecord): Promise<void> {
    await this._repo.mutate((data) => {
      data.commissions.push(record);
      return { next: data, result: undefined };
    });
  }

  async update(id: string, fn: (record: CommissionRecord) => void): Promise<CommissionRecord | null> {
    return this._repo.mutate((data) => {
      const record = data.commissions.find(c => c.id === id);
      if (!record) return { next: data, result: null };
      fn(record);
      record.updatedAt = Date.now();
      return { next: data, result: record };
    });
  }

  /** Drop the in-memory cache so the next read() fetches from disk. Test hook. */
  invalidate(): void {
    this._repo.invalidate();
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
  }
}

export const commissionRepo = new CommissionRepo();  // default singleton for production use
