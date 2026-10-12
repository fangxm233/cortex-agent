import path from 'node:path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

/** One routine update a worker sent its lead, not yet given to the lead. */
export interface TeamInboxItem {
  at: number;
  /** The first line of the worker's reply, capped. */
  text: string;
}

/** A worker's unread routine updates, oldest first. `dropped` counts older ones cut by the cap. */
export interface TeamInboxWorker {
  workerId: string;
  name: string;
  items: TeamInboxItem[];
  dropped: number;
}

interface TeamInboxData {
  /** leadId → workerId → that worker's unread updates. */
  leads: Record<string, Record<string, TeamInboxWorker>>;
}

/** Unread routine updates kept per worker; older ones are counted, not kept. */
export const TEAM_INBOX_MAX_PER_WORKER = 5;

/** `older`'s items before `newer`'s (the sort is stable, so equal times keep that order), cut to
 *  the newest `max`. The name is `newer`'s. */
function merge(older: TeamInboxWorker, newer: TeamInboxWorker, max: number): TeamInboxWorker {
  const items = [...older.items, ...newer.items].sort((a, b) => a.at - b.at);
  const cut = Math.max(0, items.length - max);
  return {
    workerId: newer.workerId, name: newer.name || older.name,
    items: items.slice(cut), dropped: older.dropped + newer.dropped + cut,
  };
}

/**
 * Each lead's unread routine updates from its workers. Persisted so a restart does not lose them;
 * an update leaves the inbox once it has been given to the lead (`take`).
 */
export class TeamInboxRepo {
  private readonly repo: JsonRepository<TeamInboxData>;

  constructor(filePath = path.join(STORE_DIR, 'team-inbox.json'), private readonly max = TEAM_INBOX_MAX_PER_WORKER) {
    this.repo = new JsonRepository<TeamInboxData>({
      filePath,
      defaultValue: () => ({ leads: {} }),
      migrate: (raw) => {
        const leads = (raw as TeamInboxData | null)?.leads;
        return { leads: leads && typeof leads === 'object' && !Array.isArray(leads) ? leads : {} };
      },
    });
  }

  async add(leadId: string, worker: { workerId: string; name: string }, item: TeamInboxItem): Promise<void> {
    await this.repo.mutate((data) => {
      const lead = { ...(data.leads[leadId] ?? {}) };
      const current = lead[worker.workerId] ?? { ...worker, items: [], dropped: 0 };
      lead[worker.workerId] = merge(current, { ...worker, items: [item], dropped: 0 }, this.max);
      return { next: { leads: { ...data.leads, [leadId]: lead } }, result: undefined };
    });
  }

  /** Every unread update of this lead, worker by worker (oldest update first), now marked read. */
  async take(leadId: string): Promise<TeamInboxWorker[]> {
    return this.repo.mutate((data) => {
      const lead = data.leads[leadId];
      if (!lead) return { next: data, result: [] };
      const { [leadId]: _taken, ...rest } = data.leads;
      const workers = Object.values(lead)
        .filter(w => w.items.length > 0)
        .sort((a, b) => a.items[0].at - b.items[0].at);
      return { next: { leads: rest }, result: workers };
    });
  }

  /** Put back updates that were taken but never reached the lead. */
  async restore(leadId: string, workers: TeamInboxWorker[]): Promise<void> {
    if (workers.length === 0) return;
    await this.repo.mutate((data) => {
      const lead = { ...(data.leads[leadId] ?? {}) };
      for (const w of workers) {
        const current = lead[w.workerId];
        lead[w.workerId] = current ? merge(w, current, this.max) : { ...w, items: [...w.items] };
      }
      return { next: { leads: { ...data.leads, [leadId]: lead } }, result: undefined };
    });
  }

  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const teamInboxRepo = new TeamInboxRepo();
