//
// Usage (run from the agent-server/ dir so tsx resolves the @-path aliases via its tsconfig.json):
//   cd agent-server
//   CORTEX_UI_HTTP=1 CORTEX_UI_PORT=3004 CORTEX_UI_CORS_ORIGINS=tauri://localhost \
//     node --import tsx scripts/serve-ui-standalone.ts
//   (spaDir defaults to <repo>/web/dist; override with CORTEX_UI_SPA_DIR. The token is read from
//    ~/.cortex/config/.env CORTEX_CLIENT_TOKEN via getClientToken, same as the daemon.)

import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { EventBus } from '@events/index.js';
import { MockAdapter } from '@platform/testing.js';
import { createUiService } from '@domain/ui-service/index.js';
import type { UiServiceDeps } from '@domain/ui-service/index.js';
// The Web UI transport lives in-core (entry/start-ui-http wiring; loaded on demand by the daemon).
import { startUiHttpServer } from '@entry/start-ui-http.js';
import { projectStore } from '@domain/projects/index.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { threadStore } from '@store/thread-repo.js';
import { taskStore } from '@domain/tasks/store.js';
import { executionRepo } from '@store/execution-repo.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { executionLogTailer } from '@domain/executions/log-tailer.js';
import { runningExecutions } from '@core/running-executions.js';
import { getCostSummary } from '@domain/costs/cost-tracker.js';

const log = createLogger('serve-ui-standalone');

// Load the real .env so getClientToken() sees the same CORTEX_CLIENT_TOKEN the daemon uses.
dotenv.config({ path: path.join(CONFIG_DIR, '.env') });

// This tool exists to serve the UI; force the env gate on so a caller who forgets it still works.
process.env.CORTEX_UI_HTTP = process.env.CORTEX_UI_HTTP ?? '1';

// spaDir default: the built web bundle (repo web/dist), relative to this script's location.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultSpaDir = path.resolve(scriptDir, '../../web/dist');
const spaDir = process.env.CORTEX_UI_SPA_DIR || defaultSpaDir;

/**
 * Read-only scheduler stub. The standalone tool serves live-read UI panels; it does NOT own the
 * scheduler timing loop (that lives in the daemon). schedules.* queries return empty and mutations
 * reject — enough for the read-only verification panels without pulling in the runner wiring.
 */
const schedulerStub: UiServiceDeps['scheduler'] = {
  list: async () => [],
  get: async () => null,
  pause: async () => { throw new Error('scheduler mutations are unavailable in the standalone UI server'); },
  resume: async () => { throw new Error('scheduler mutations are unavailable in the standalone UI server'); },
  remove: async () => { throw new Error('scheduler mutations are unavailable in the standalone UI server'); },
  add: async () => { throw new Error('scheduler mutations are unavailable in the standalone UI server'); },
};

async function main(): Promise<void> {
  if (!fs.existsSync(spaDir)) {
    log.warn(`spaDir does not exist: ${spaDir} — the SPA will 404, but tRPC endpoints still work.`);
  }

  // Hydrate the on-disk stores that back the read-only UI queries (same calls app.ts makes).
  await projectStore.initialize();
  taskStore.load();
  threadStore.load();
  executionRepo.load();

  const bus = new EventBus();
  const adapter = new MockAdapter({ adminChannel: 'standalone-ui' });

  const uiService = createUiService({
    projectStore,
    sessionStore,
    threadStore,
    taskStore,
    scheduler: schedulerStub,
    executionRegistry,
    executionLogTailer,
    runningExecutions,
    costSummary: getCostSummary,
    bus,
    adapter,
  });

  const server = startUiHttpServer({ uiService, spaDir });
  if (!server) {
    log.error('startUiHttpServer returned null — is CORTEX_UI_HTTP truthy?');
    process.exit(1);
  }

  const shutdown = async () => {
    log.info('Shutting down standalone UI server…');
    await server.close().catch(() => {});
    await bus.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(`Standalone UI server up. spaDir=${spaDir}. Ctrl-C to stop.`);
}

main().catch((e) => {
  log.error(`Fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
