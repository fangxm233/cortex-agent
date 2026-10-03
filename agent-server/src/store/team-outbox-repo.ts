import path from 'node:path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

/** A worker report a restart kept its lead from receiving, waiting to be delivered once it is back. */
export interface TeamOutboxEntry {
  id: string;
  leadId: string;
  workerId: string;
  status: 'completed' | 'failed' | 'stopped';
  /** The worker's full final reply for that turn. */
  text: string;
  at: number;
}

interface TeamOutboxData {
  reports: TeamOutboxEntry[];
}

export class TeamOutboxRepo {
  private readonly repo: JsonRepository<TeamOutboxData>;

  constructor(filePath = path.join(STORE_DIR, 'team-outbox.json')) {
    this.repo = new JsonRepository<TeamOutboxData>({
      filePath,
      defaultValue: () => ({ reports: [] }),
      migrate: (raw) => ({
        reports: Array.isArray((raw as TeamOutboxData | null)?.reports) ? (raw as TeamOutboxData).reports : [],
      }),
    });
  }

  async add(entry: TeamOutboxEntry): Promise<void> {
    await this.repo.mutate((data) => ({
      next: { reports: [...data.reports.filter(r => r.id !== entry.id), { ...entry }] },
      result: undefined,
    }));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    await this.repo.mutate((data) => ({
      next: { reports: data.reports.filter(r => !drop.has(r.id)) },
      result: undefined,
    }));
  }

  /** Oldest first. */
  async list(): Promise<TeamOutboxEntry[]> {
    const data = await this.repo.read();
    return data.reports.map(r => ({ ...r })).sort((a, b) => a.at - b.at);
  }

  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const teamOutboxRepo = new TeamOutboxRepo();
