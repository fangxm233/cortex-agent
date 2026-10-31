// The aistatus.cc leaderboard opt-in, fed from the cost ledger: every row the ledger files is sent
// as one usage record, while `~/.aistatus/config.yaml` allows it. Uploading is best-effort and never
// holds up or fails the ledger write it follows.

import { UsageUploader, flushUsageUploads, type AIStatusConfig } from 'aistatus';
import { createLogger } from '@core/log.js';
import { inTestProcess } from '@core/test-process.js';
import { readUsageSharing, type UsageSharingSettings } from './aistatus-config.js';
import type { CostEntry } from './cost-tracker.js';

const log = createLogger('leaderboard');

/** Long enough to drain a normal queue, short enough to stay inside the shutdown budget. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;

/** One record in the shape `UsageUploader.upload` takes. */
export interface LeaderboardRecord {
  ts: string;
  provider: string;
  model: string;
  in: number;
  out: number;
  cache_creation_in: number;
  cache_read_in: number;
  cost: number;
  latency_ms?: number;
}

export type LeaderboardTarget = Pick<UsageUploader, 'setConfig' | 'upload' | 'enabled'>;

export interface LeaderboardUploadDeps {
  readSharing?: () => UsageSharingSettings;
  /** Null: nothing is ever sent. */
  uploader?: LeaderboardTarget | null;
}

/** Provider families the gateway folded vendor routes into, so one vendor stays one leaderboard name. */
const PROVIDER_FAMILIES = ['anthropic', 'openai', 'google', 'openrouter'];

/** Names as the gateway reported them: a namespaced model names its own vendor, and a route under a
 *  known family (`openai-codex`, `google-gemini-cli`) is reported as that family. */
function leaderboardProvider(provider: string, model: string): string {
  if (model.includes('/')) return model.split('/', 1)[0];
  return PROVIDER_FAMILIES.find((family) => provider.startsWith(family)) ?? provider;
}

/** Claude's context-window variant (`claude-opus-x[1m]`) is a client-side choice; the API reports
 *  the bare model, which is what the gateway uploaded. */
function leaderboardModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

function entryProvider(entry: CostEntry): string | null {
  if (entry.provider) return entry.provider;
  return entry.backend === 'claude' ? 'anthropic' : null;
}

/** The record a ledger row uploads as; null when the row names no provider to credit. */
export function leaderboardRecord(entry: CostEntry): LeaderboardRecord | null {
  const provider = entryProvider(entry);
  if (!provider) return null;
  const model = entry.model ? leaderboardModel(entry.model) : `${provider}/unknown`;
  return {
    ts: entry.timestamp,
    provider: leaderboardProvider(provider, model),
    model,
    in: entry.input_tokens ?? 0,
    out: entry.output_tokens ?? 0,
    cache_creation_in: entry.cache_creation_tokens ?? 0,
    cache_read_in: entry.cache_read_tokens ?? 0,
    cost: entry.cost_usd ?? 0,
    ...(entry.duration_s != null ? { latency_ms: Math.round(entry.duration_s * 1000) } : {}),
  };
}

function uploadConfig(sharing: UsageSharingSettings): AIStatusConfig {
  return {
    uploadEnabled: sharing.enabled,
    name: sharing.name || null,
    org: sharing.org || null,
    email: sharing.email || null,
  };
}

export interface LeaderboardUpload {
  /** Queue one ledger row when sharing is on. Never throws. */
  share(entry: CostEntry): void;
}

export function createLeaderboardUpload(deps: LeaderboardUploadDeps = {}): LeaderboardUpload {
  const readSharing = deps.readSharing ?? (() => readUsageSharing());
  const uploader = deps.uploader ?? null;
  return {
    share(entry) {
      if (!uploader) return;
      try {
        // Read per row: the setting is changed from the UI without a restart.
        uploader.setConfig(uploadConfig(readSharing()));
        if (!uploader.enabled) return;
        const record = leaderboardRecord(entry);
        if (record) uploader.upload(record);
      } catch (error) {
        log.warn(`leaderboard upload skipped: ${(error as Error)?.message ?? error}`);
      }
    },
  };
}

const SHARING_OFF: AIStatusConfig = { uploadEnabled: false, name: null, org: null, email: null };

/** A test process never sends anything off the machine, whatever the real config says. */
function defaultUploader(): LeaderboardTarget | null {
  return inTestProcess() ? null : new UsageUploader(SHARING_OFF);
}

/** The daemon's uploader over `~/.aistatus/config.yaml`. */
export const leaderboardUpload: LeaderboardUpload = createLeaderboardUpload({ uploader: defaultUploader() });

/** Send what is still queued; called once on shutdown. */
export async function flushLeaderboardUploads(timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS): Promise<void> {
  await flushUsageUploads(timeoutMs).catch((error: unknown) => {
    log.warn(`leaderboard flush failed: ${(error as Error)?.message ?? error}`);
  });
}
