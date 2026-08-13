// input:  retention-candidates.json + JsonRepository
// output: RetentionCandidateRepo and singleton
// pos:    Persists two-sweep orphan retention candidates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import path from 'node:path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

export type RetentionCandidateCategory = 'history' | 'pi';

interface RetentionCandidateData {
  categories: Partial<Record<RetentionCandidateCategory, Record<string, number>>>;
}

function emptyData(): RetentionCandidateData {
  return { categories: {} };
}

export class RetentionCandidateRepo {
  private repo: JsonRepository<RetentionCandidateData>;

  constructor(filePath = path.join(STORE_DIR, 'retention-candidates.json')) {
    this.repo = new JsonRepository<RetentionCandidateData>({
      filePath,
      defaultValue: emptyData,
    });
  }

  async mark(category: RetentionCandidateCategory, key: string, stamp: number): Promise<void> {
    await this.repo.mutate((data) => {
      const group = data.categories[category] ?? {};
      group[key] = stamp;
      data.categories[category] = group;
      return { next: data, result: undefined };
    });
  }

  async isConfirmed(category: RetentionCandidateCategory, key: string, stamp: number): Promise<boolean> {
    const data = await this.repo.read();
    return data.categories[category]?.[key] === stamp;
  }

  async clear(category: RetentionCandidateCategory, key: string): Promise<void> {
    await this.repo.mutate((data) => {
      const group = data.categories[category];
      if (!group || !(key in group)) return { next: data, result: undefined };
      delete group[key];
      if (Object.keys(group).length === 0) delete data.categories[category];
      return { next: data, result: undefined };
    });
  }

  async clearCategory(category: RetentionCandidateCategory): Promise<void> {
    await this.repo.mutate((data) => {
      delete data.categories[category];
      return { next: data, result: undefined };
    });
  }

  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const retentionCandidateRepo = new RetentionCandidateRepo();
