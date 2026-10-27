import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '@core/atomic-write.js';
import { JsonRepository } from '@core/json-repository.js';
import { DATA_DIR, STORE_DIR } from '@core/paths.js';
import type { RateLimitThrottleState } from '@domain/costs/rate-limit-throttle.js';
import type { ResumeEntry } from '@domain/costs/resume-registry.js';
import type { ProviderUsage } from '@domain/costs/usage-store.js';

export const PROVIDER_STATE_FILE = path.join(STORE_DIR, 'provider-state.json');

export interface ProviderStateData {
  rateLimitThrottle: RateLimitThrottleState | null;
  resumeQueue: ResumeEntry[];
  providerUsage: ProviderUsage[];
  /** Epoch seconds each provider's subscription was last signed out through Cortex. */
  subscriptionSignOuts?: Record<string, number>;
}

function defaultData(): ProviderStateData {
  return { rateLimitThrottle: null, resumeQueue: [], providerUsage: [] };
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderStateData(value: Record<string, unknown>): boolean {
  const throttle = value.rateLimitThrottle;
  const usage = value.providerUsage;
  return Object.hasOwn(value, 'rateLimitThrottle')
    && Object.hasOwn(value, 'resumeQueue')
    && (throttle === null || isJsonRecord(throttle))
    && Array.isArray(value.resumeQueue)
    && (usage === undefined || Array.isArray(usage));
}

async function existingProviderStateIsValid(filePath: string): Promise<boolean> {
  const existing = await readJsonRecord(filePath);
  if (!existing) return false;
  if (!isProviderStateData(existing)) {
    throw new Error(`${filePath} must contain rateLimitThrottle and resumeQueue`);
  }
  return true;
}

function hasLegacyProviderState(schedules: Record<string, unknown>): boolean {
  return Object.hasOwn(schedules, 'rateLimitThrottle') || Object.hasOwn(schedules, 'resumeQueue');
}

function legacyProviderState(schedules: Record<string, unknown>): ProviderStateData {
  return {
    rateLimitThrottle: (schedules.rateLimitThrottle as RateLimitThrottleState | null | undefined) ?? null,
    resumeQueue: (schedules.resumeQueue as ResumeEntry[] | null | undefined) ?? [],
    providerUsage: [],
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
  if (!(await existingProviderStateIsValid(providerStateFile))) {
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

  async getRateLimitThrottle(): Promise<RateLimitThrottleState | null> {
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

  async setProviderUsage(records: ProviderUsage[]): Promise<void> {
    await this.repo.mutate((data) => ({
      next: { ...data, providerUsage: records },
      result: undefined,
    }));
  }

  async getProviderUsage(): Promise<ProviderUsage[]> {
    return (await this.repo.read()).providerUsage ?? [];
  }

  async getSubscriptionSignOuts(): Promise<Record<string, number>> {
    return { ...(await this.repo.read()).subscriptionSignOuts };
  }

  /** Null clears the provider's entry. */
  async setSubscriptionSignOut(provider: string, at: number | null): Promise<void> {
    await this.repo.mutate((data) => {
      const signOuts = { ...data.subscriptionSignOuts };
      if (at === null) delete signOuts[provider];
      else signOuts[provider] = at;
      return { next: { ...data, subscriptionSignOuts: signOuts }, result: undefined };
    });
  }

  flush(): Promise<void> {
    return this.repo.flush();
  }
}

export const providerStateRepo = new ProviderStateRepo();
