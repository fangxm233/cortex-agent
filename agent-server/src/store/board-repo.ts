import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { JsonRepository } from '@core/json-repository.js';
import { STORE_DIR } from '@core/paths.js';

export const BOARDS_FILE = path.join(STORE_DIR, 'boards.json');

export type BoardStatus = 'active' | 'done' | 'abandoned';

/** One registered board: a status page bound to sessions, edited by agents as plain HTML under
 *  `<contextDir>/boards/<slug>/`. The registry holds facts only — never the page body. */
export interface BoardRecord {
  id: string;            // 8-hex
  projectId: string;
  slug: string;          // directory name under <contextDir>/boards/
  title: string;
  status: BoardStatus;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closeNote?: string;
}

export interface BoardsData {
  boards: BoardRecord[];
}

function defaultData(): BoardsData {
  return { boards: [] };
}

function migrate(raw: unknown): BoardsData {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as BoardsData).boards)) return defaultData();
  return raw as BoardsData;
}

export function newBoardId(): string {
  return randomBytes(4).toString('hex');
}

export class BoardRepo {
  private _repo: JsonRepository<BoardsData>;

  constructor(filePath: string = BOARDS_FILE) {
    this._repo = new JsonRepository<BoardsData>({ filePath, defaultValue: defaultData, migrate });
  }

  async list(projectId?: string): Promise<BoardRecord[]> {
    const data = await this._repo.read();
    const all = projectId === undefined ? data.boards : data.boards.filter(b => b.projectId === projectId);
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async find(id: string): Promise<BoardRecord | null> {
    const data = await this._repo.read();
    return data.boards.find(b => b.id === id) ?? null;
  }

  async findBySlug(projectId: string, slug: string): Promise<BoardRecord | null> {
    const data = await this._repo.read();
    return data.boards.find(b => b.projectId === projectId && b.slug === slug) ?? null;
  }

  async add(record: BoardRecord): Promise<void> {
    await this._repo.mutate((data) => {
      data.boards.push(record);
      return { next: data, result: undefined };
    });
  }

  /** Read-modify-write one record under the repo lock. `fn` returning `false` declines the change;
   *  the record comes back untouched. */
  async update(id: string, fn: (record: BoardRecord) => void | false): Promise<BoardRecord | null> {
    return this._repo.mutate((data) => {
      const record = data.boards.find(b => b.id === id);
      if (!record) return { next: data, result: null };
      if (fn(record) === false) return { next: data, result: record };
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

export const boardRepo = new BoardRepo();
