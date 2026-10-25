import type { AuthStatusSnapshot } from '@domain/auth/auth-status.js';
import { normalizeProviderList, toIdent, type NameCatalog } from './normalize.js';
import type { HeartbeatEvent } from './schema.js';

/** The settings a heartbeat reports, by name; all booleans the user can see in Settings. */
export const HEARTBEAT_SETTINGS = [
  'teamEnabled', 'serverAutoUpdate', 'serverUpdateDisable', 'autoResume', 'bgContinuation',
  'streamDeltas', 'clientHotReloadEnabled', 'storeArchiveEnabled', 'providerUsageCollectionEnabled',
  'claudeWindowWarmupEnabled', 'feishuSkillsInWeb', 'memoryIndexRegenEnabled',
] as const;

export interface HeartbeatSources {
  authStatus: () => Promise<AuthStatusSnapshot | null>;
  projects: () => number;
  onlineDevices: () => Array<{ platform: string }>;
  activeSessions24h: () => Promise<number>;
  uptimeS: () => number;
  settings: () => Record<string, unknown>;
  catalog: () => Promise<NameCatalog>;
}

type Account = AuthStatusSnapshot['accounts'][number];
type DevicePlatform = keyof HeartbeatEvent['clientPlatforms'];

function usable(account: Account): boolean {
  return account.state === 'logged-in' || account.state === 'expiring';
}

function claudeBilling(accounts: Account[]): HeartbeatEvent['claudeBilling'] {
  const claude = accounts.find((account) => account.backend === 'claude' && usable(account));
  if (!claude) return 'none';
  return claude.authType === 'api_key' ? 'api' : 'plan';
}

function platformCounts(devices: Array<{ platform: string }>): HeartbeatEvent['clientPlatforms'] {
  const counts: HeartbeatEvent['clientPlatforms'] = {};
  for (const { platform } of devices) {
    const key: DevicePlatform = ['linux', 'darwin', 'win32'].includes(platform)
      ? platform as DevicePlatform : 'other';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function pickSettings(settings: Record<string, unknown>): Record<string, boolean> {
  return Object.fromEntries(HEARTBEAT_SETTINGS
    .filter((key) => typeof settings[key] === 'boolean')
    .map((key) => [toIdent(key), settings[key] as boolean]));
}

export async function buildHeartbeat(sources: HeartbeatSources, now = new Date()): Promise<HeartbeatEvent> {
  const snapshot = await sources.authStatus().catch(() => null);
  const accounts: Account[] = snapshot?.accounts.filter(usable) ?? [];
  const devices = sources.onlineDevices();
  const piNames = accounts.filter((account) => account.backend === 'pi').map((account) => account.provider);
  return {
    type: 'heartbeat',
    at: now.toISOString(),
    backends: [...new Set(accounts.map((account): 'claude' | 'pi' => account.backend))],
    claudeBilling: claudeBilling(accounts),
    piProviders: normalizeProviderList(piNames, await sources.catalog()).slice(0, 60),
    projects: sources.projects(),
    onlineClients: devices.length,
    clientPlatforms: platformCounts(devices),
    activeSessions24h: await sources.activeSessions24h().catch(() => 0),
    uptimeH: Math.round((sources.uptimeS() / 3600) * 100) / 100,
    settings: pickSettings(sources.settings()),
  };
}
