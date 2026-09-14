// input:  project-dirs.json
// output: ProjectDirRepo (async getProjectDir / setProjectDir / removeProjectDir / getAllProjectDirs)
// pos:    Project-device code directory mapping persistence layer. Based on JsonRepository abstraction, AsyncMutex serializes reads/writes of project-dirs.json.
//         Channel→project reverse lookup used to live here (getChannelProject); it now lives on PlatformAdapter as resolveInboundProject.

import * as path from 'path';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

const PROJECT_DIRS_FILE = path.join(STORE_DIR, 'project-dirs.json');

/** Shape of project-dirs.json: `{"projectName": {"machineName": "dirPath", ...}, ...}` */
export type ProjectDirsData = Record<string, Record<string, string>>;

interface ProjectDirRepoOptions {
  filePath?: string;
}

export class ProjectDirRepo {
  private readonly _repo: JsonRepository<ProjectDirsData>;

  constructor(opts: ProjectDirRepoOptions = {}) {
    this._repo = new JsonRepository<ProjectDirsData>({
      filePath: opts.filePath ?? PROJECT_DIRS_FILE,
      defaultValue: () => ({}),
      migrate: (raw) => (typeof raw === 'object' && raw !== null ? (raw as ProjectDirsData) : ({})),
    });
  }

  async getProjectDir(project: string, machine: string): Promise<string | null> {
    const data = await this._repo.read();
    return (data[project] && data[project][machine]) ?? null;
  }

  async setProjectDir(project: string, machine: string, dirPath: string): Promise<void> {
    await this._repo.mutate((data) => {
      if (!data[project]) data[project] = {};
      data[project][machine] = dirPath;
      return { next: data, result: undefined };
    });
  }

  async removeProjectDir(project: string, machine: string): Promise<void> {
    await this._repo.mutate((data) => {
      if (data[project]) {
        delete data[project][machine];
        if (Object.keys(data[project]).length === 0) delete data[project];
      }
      return { next: data, result: undefined };
    });
  }

  async getAllProjectDirs(): Promise<Record<string, Record<string, string>>> {
    return { ...(await this._repo.read()) };
  }

  /** Wait for any in-flight mutate() to complete. For graceful SIGTERM drain. */
  flush(): Promise<void> {
    return this._repo.flush();
  }
}

export const projectDirRepo = new ProjectDirRepo();
