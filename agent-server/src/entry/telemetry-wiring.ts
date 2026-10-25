// Composition of the telemetry service: the heartbeat's data sources live all over the domain
// layer, so they are gathered here rather than imported by domain/telemetry itself.
import { getSettings } from '@core/settings.js';
import { getAuthStatus } from '@domain/auth/auth-status.js';
import { projectStore } from '@domain/projects/index.js';
import { getOnlineDevices } from '@domain/remote/client-manager.js';
import { buildHeartbeat, type HeartbeatSources } from '@domain/telemetry/heartbeat.js';
import { loadNameCatalog } from '@domain/telemetry/normalize.js';
import { startTelemetry, stopTelemetry } from '@domain/telemetry/service.js';
import { sessionStore } from '@store/session-registry-repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function activeSessions24h(): Promise<number> {
  const since = Date.now() - DAY_MS;
  const recent = await sessionStore.listRecentSessions(10_000);
  return recent.filter((session) => Date.parse(session.lastUsedAt ?? '') >= since).length;
}

function heartbeatSources(): HeartbeatSources {
  return {
    authStatus: () => getAuthStatus(),
    projects: () => projectStore.list().length,
    onlineDevices: () => getOnlineDevices(),
    activeSessions24h,
    uptimeS: () => process.uptime(),
    settings: () => getSettings() as unknown as Record<string, unknown>,
    catalog: () => loadNameCatalog(new Date().toISOString().slice(0, 10)),
  };
}

export function startTelemetryService(): void {
  const sources = heartbeatSources();
  startTelemetry({ collectHeartbeat: () => buildHeartbeat(sources) });
}

export { stopTelemetry as stopTelemetryService };
