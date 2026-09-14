// input:  JsonRepository + STORE_DIR
// output: ProjectConduitsStore (projectId → conduit file-backed store)
// pos:    Platform-agnostic file-backed project→conduit mapping. Slack defaults to
//         channel-registry.json (backward compat); other adapters pass a distinct
//         filePath (e.g. Feishu → feishu-channel-registry.json).

import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

const CHANNEL_REGISTRY_FILE = path.join(STORE_DIR, 'channel-registry.json');

type ConduitData = Record<string, string>;

export class ProjectConduitsStore {
  private readonly _repo: JsonRepository<ConduitData>;

  constructor(filePath?: string) {
    this._repo = new JsonRepository<ConduitData>({
      filePath: filePath ?? CHANNEL_REGISTRY_FILE,
      defaultValue: () => ({}),
      migrate: (raw) => (typeof raw === 'object' && raw !== null ? (raw as ConduitData) : ({})),
    });
  }

  async get(projectId: string): Promise<string | null> {
    const data = await this._repo.read();
    return data[projectId] ?? null;
  }

  async set(projectId: string, conduit: string): Promise<void> {
    await this._repo.mutate((data) => {
      data[projectId] = conduit;
      return { next: data, result: undefined };
    });
  }

  async remove(projectId: string): Promise<void> {
    await this._repo.mutate((data) => {
      delete data[projectId];
      return { next: data, result: undefined };
    });
  }

  async getAll(): Promise<Record<string, string>> {
    return { ...(await this._repo.read()) };
  }

  flush(): Promise<void> {
    return this._repo.flush();
  }
}
