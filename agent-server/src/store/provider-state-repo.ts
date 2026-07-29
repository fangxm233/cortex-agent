// input:  provider/schedule state JSON, JsonRepository
// output: ProviderStateRepo and legacy migration
// pos:    Provider health and interrupted-work persistence
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { JsonRepository } from '@core/json-repository.js';
import { DATA_DIR, STORE_DIR } from '@core/paths.js';
import type {
  PersistedThrottleState,
  RateLimitThrottleState,
} from '@domain/costs/rate-limit-throttle.js';
import type { ResumeEntry } from '@domain/costs/resume-registry.js';

export const PROVIDER_STATE_FILE = path.join(STORE_DIR, 'provider-state.json');

export interface ProviderStateData {
  rateLimitThrottle: PersistedThrottleState | null;
  resumeQueue: ResumeEntry[];
}

function defaultData(): ProviderStateData {
  return { rateLimitThrottle: null, resumeQueue: [] };
}

function serialize(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${filePath} must contain a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function hasLegacyProviderState(schedules: Record<string, unknown>): boolean {
  return Object.hasOwn(schedules, 'rateLimitThrottle') || Object.hasOwn(schedules, 'resumeQueue');
}

function legacyProviderState(schedules: Record<string, unknown>): ProviderStateData {
  return {
    rateLimitThrottle: (schedules.rateLimitThrottle as PersistedThrottleState | null | undefined) ?? null,
    resumeQueue: (schedules.resumeQueue as ResumeEntry[] | null | undefined) ?? [],
  };
}

function stripLegacyProviderState(schedules: Record<string, unknown>): Record<string, unknown> {
  const next = { ...schedules };
  delete next.rateLimitThrottle;
  delete next.resumeQueue;
  return next;
}

export async function migrateProviderStateFromSchedules(dataDir: string = DATA_DIR): Promise<void> {
  const storeDir = path.join(dataDir, 'data');
  const schedulesFile = path.join(storeDir, 'schedules.json');
  const schedules = await readJsonRecord(schedulesFile);
  if (!schedules || !hasLegacyProviderState(schedules)) return;

  const providerStateFile = path.join(storeDir, 'provider-state.json');
  if (!(await fileExists(providerStateFile))) {
    await atomicWrite(providerStateFile, serialize(legacyProviderState(schedules)));
  }
  await atomicWrite(schedulesFile, serialize(stripLegacyProviderState(schedules)));
}

export class ProviderStateRepo {
  private readonly repo: JsonRepository<ProviderStateData>;

  constructor(filePath: string = PROVIDER_STATE_FILE) {
    this.repo = new JsonRepository<ProviderStateData>({
      filePath,
      defaultValue: defaultData,
    });
  }

  async setRateLimitThrottle(state: RateLimitThrottleState | null): Promise<void> {
    await this.repo.mutate((data) => ({
      next: { ...data, rateLimitThrottle: state },
      result: undefined,
    }));
  }

  async getRateLimitThrottle(): Promise<PersistedThrottleState | null> {
    return (await this.repo.read()).rateLimitThrottle ?? null;
  }

  async setResumeQueue(entries: ResumeEntry[]): Promise<void> {
    await this.repo.mutate((data) => ({
      next: { ...data, resumeQueue: entries },
      result: undefined,
    }));
  }

  async getResumeQueue(): Promise<ResumeEntry[]> {
    return (await this.repo.read()).resumeQueue ?? [];
  }

  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const providerStateRepo = new ProviderStateRepo();
