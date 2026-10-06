import { mkdirSync } from 'fs';
import * as path from 'path';
import { extractTuiAdapter } from '@platform/index.js';
import { stopBrowser } from '@platform/browser/managed-browser.js';
import { stopAllDevicePorts } from '@domain/remote/device-port.js';
import { forgetDeviceBrowsers } from '@domain/remote/device-browser.js';
import type { PlatformAdapter } from '@platform/index.js';
// Gate for the in-core Web UI transport: static import is @trpc-free (node builtins + an erased
// type only); the transport (which pulls @trpc/server + jose) is dynamic-imported inside the gate,
// gated on CORTEX_UI_HTTP, so it stays runtime-lazy for Slack/TUI-only installs.
import { startUiHttpIfEnabled } from '@entry/ui-http-gate.js';
import { startClientHotReloadJob, startStoreArchiveJob } from '@entry/boot-jobs.js';
import { createHotReloadingAdapter } from '@entry/admin-channel-hot-reload.js';
import { moveDraftAttachments } from '@entry/draft-attachments.js';
import { WORKSPACE_DIR, CONFIG_DIR, DATA_DIR, STORE_DIR, DEFAULTS_DIR, CONTEXT_DIR } from '@core/paths.js';
import { loadRuntimeDotenv } from '@core/runtime-env.js';
import { migrateEnvToSettings } from '@core/settings-migration.js';
import { tryAcquireSingletonLock, releaseSingletonLock } from '@core/singleton-lock.js';
import { engines } from '@domain/runs/engines.js';
import { recoverTuiOrphans } from '../agent-adapter/claude/adapter.js';
import { startWebhookServer } from '@orch/routing/webhook.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { initHookBridge, setOnStale } from '@orch/routing/hook-bridge.js';
import { interactionRecords } from '@orch/interactions/interaction-records.js';
import * as askUserQuestion from '@orch/interactions/ask-user-question.js';
import { registerCommands } from '@orch/routing/commands/index.js';
import { buildAuthRequiredLoginAction } from '@orch/routing/commands/login-notice.js';
import { cancelChannelRuns, cancelLiveExecution } from '@orch/routing/commands/cancel.js';
import { projectDirRepo } from '@store/project-dir-repo.js';
import { waitpointRepo } from '@store/waitpoint-repo.js';
import { cancelWaitpoint } from '@domain/waitpoints/service.js';
import { recoverWaitpoints, startWaitpointSweep, stopWaitpointSweep } from '../orchestration/waitpoint-sweep.js';
import { projectStore } from '@domain/projects/index.js';
import { sendStartupDmIfConfigured } from './startup-notify.js';
import { startPlatformAdapters, type PlatformConnections } from './platform-connect.js';
import { subscribeDaemonNotices } from './daemon-notice.js';
import { startGateway, stopGateway } from '@domain/costs/gateway-manager.js';
import { prewarmPiSdk } from '@core/pi-sdk.js';
import { startClientManager, stopClientManager, getOnlineDevices, isDeviceOnline, sendCommand } from '@domain/remote/client-manager.js';
import { startAllRemoteClients, releaseUnregisteredDevices } from '@domain/remote/client-lifecycle.js';
import { initClientHotReload } from '@domain/remote/client-hot-reload.js';
import { createServerUpdateCoordinator } from '@domain/system/server-update-check.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { conversationHistory, CONVERSATION_HISTORY_DIR } from '@store/conversation-history-repo.js';
import { TOOL_IMAGES_DIR } from '@store/tool-image-files.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { teamOutboxRepo } from '@store/team-outbox-repo.js';
import { executionRepo } from '@store/execution-repo.js';
import { initializeProductionAttemptIdentity } from '@domain/benchmark/production-attempt-identity.js';
import { DEFAULT_ENVIRONMENTS_DIR, ENVIRONMENTS_DIR, getEnvironmentRevision, loadEnvironments, mergeDefaultEnvironments, startEnvironmentWatcher } from '@domain/agents/environments/index.js';
import { startMemoryWatcher } from '@domain/memory/watcher.js';
import { defaultClaudeModel } from '@domain/agents/index.js';
import { applyAuthEnv } from '@domain/auth/anthropic-env.js';
import { createEditHandler } from '@orch/routing/edit-handler.js';
import { setLocale, normalizeLocale } from '@core/i18n.js';
import { loadLang } from '@domain/system/preferences.js';

// Extracted modules
import { ensureMcpConfig, shouldSyncManagedStartupAssets } from './startup-helpers.js';
import { createLogger } from '@core/log.js';
import { captureAuthTokensForRuntime, ensureAuthTokens } from '@core/auth.js';
import { runRegistry } from '@core/run-registry.js';
import { sessionHolds } from '@core/session-holds.js';
import { sessionStates } from '@core/session-state.js';
import { getSettings, onSettingsChange } from '@core/settings.js';
import { sessionTodos } from '@core/session-todos.js';
import { buildSessionRetentionLiveness } from '@core/session-retention-liveness.js';
import { planApprovals } from '@orch/interactions/plan-approvals.js';
import { busyTracker } from '@orch/busy-tracker.js';
import { buildExecutionStatusReport } from '@orch/status-helpers.js';
import { reprocessMessage } from '@orch/edit-retry.js';
import { initScheduledRunner, initAuthExpiryScan, createScheduler, setBus } from '@domain/scheduling/runner.js';
import { startBuiltinJobs, stopBuiltinJobs } from '@domain/scheduling/builtin-jobs.js';
import { migrateBuiltinJobSchedules } from '@domain/scheduling/builtin-job-migration.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { registerInteractionHandlers, initInteractionHandlers } from '@orch/interactions/interaction-handlers.js';
import { respondToPlan } from '@orch/interactions/plan-response.js';
import { answerQuestion } from '@orch/interactions/answer-question.js';
import { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { createUpdatePrompt } from '@orch/interactions/update-prompt.js';
import { createUiUpdatePrompt } from '@orch/interactions/ui-update-prompt.js';
import { registerMessageHandler } from '@orch/routing/message-router.js';
import { initRateLimitThrottle, clearThrottle, RATE_LIMIT_CLEAR_ACTION_ID } from '@domain/costs/rate-limit-throttle.js';
import { initResumeRegistry, getResumeCount, pendingDirectTrackSessionIds } from '@domain/costs/resume-registry.js';
import {
  dispatchPendingResumes,
  registerResumeWakeOnAgentSettle,
} from '../orchestration/resume-dispatcher.js';
import { scheduleRepo } from '@store/schedule-repo.js';
import { providerStateRepo } from '@store/provider-state-repo.js';
import { runMigrations, migrateAistatusConfigLocation } from '@store/version-migrations.js';
import { syncManagedHooks } from '@store/hook-sync.js';
import { loadHookRegistry, type HookEntry } from '@store/hook-registry.js';
import { emitCortexEvent, initHookBus } from '@core/hook-bus.js';
import { CORTEX_VERSION } from '@core/version.js';
import { syncManagedPlugins } from '@store/plugin-sync.js';
import { costRepo } from '@store/cost-repo.js';
import { getProfileConfigRevision, PROFILES_FILE, profileRepo, startProfileWatcher, setAdminNotifier as setProfileNotifier } from '@store/profile-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { retentionCandidateRepo } from '@store/retention-candidate-repo.js';
import { createDirectSession, adoptScheduledSession } from '@domain/sessions/session-lifecycle.js';
import { runSessionRetentionSweep, type RetentionLivenessSnapshot } from '@domain/sessions/session-retention.js';
import { pruneInboundAttachments } from '@orch/attachments-store.js';
import { syncClaudeUserCleanupPeriodDays } from '@domain/auth/claude-user-settings.js';
import { setSessionAsync, getSessionAsync } from '@domain/sessions/session.js';
import { getProjectDir } from '@domain/sessions/session-backup.js';
import {
  applyChannelSelection, clearChannelAgentSelection, getActiveProfile, getChannelOverride,
  getSelectionDefault, resolveBackendForChannel, switchChannelAgent, switchChannelProfile,
} from '@domain/agents/index.js';
import { isSessionCompactionSupported } from '@domain/runs/compact.js';
import { initDiskMonitor, stopDiskMonitor } from '@domain/monitor/disk-monitor.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from '@domain/monitor/event-loop-monitor.js';
import { loadMachinesFromFile, startMachineRegistryWatcher, stopMachineRegistryWatcher, setAdminNotifier as setMachineNotifier, setMachineReloadListener, getMachineRegistry } from '@domain/remote/machine-registry.js';
import { EventBus, createEventLogger } from '@events/index.js';
import { registerHookBridgeSubscribers } from '@orch/routing/hook-bridge-subscribers.js';
import { flushTeamOutbox, installTeamDelivery } from '@orch/team-delivery.js';
import { ensurePIAgentDirs } from '../agent-adapter/pi/agent-dir.js';
import { initOutboundQueue, getOutboundQueue, durablePost } from '@store/outbound-queue.js';
import { createUiService } from '@domain/ui-service/index.js';
import { getSubagentChildStatuses } from '@domain/agents/subagent/registry.js';
import { activeClaudeCaptureRegistry } from '../agent-adapter/claude/active-capture-registry.js';
import { deliverToSession, deliverToSessionDetached } from '@orch/session-gateway.js';
import { setOrchestrationRuntime } from '@orch/runtime.js';
import { startBackgroundSubagent, stopBackgroundSubagent } from '@orch/pi-background-subagent.js';
import { setPiBackgroundSubagentBridge } from '@domain/runs/adapters.js';
import { resolveRunConfig } from '@domain/runs/config-resolver.js';
import { rewindWebSession } from '../orchestration/session-rewind.js';
import { compactActiveSessionContext, compactSessionContext } from '../orchestration/session-compact.js';
import { recoverPendingInjections } from '../orchestration/pending-injection-recovery.js';
import { createTuiSessionService } from '@domain/tui-session/index.js';
import { enqueue, conduitQueues } from '@orch/conduit-queue.js';
import { getCostSummary } from '@domain/costs/cost-tracker.js';
import { initAuthEvents } from '@domain/auth/auth-events.js';
import { registerAuthWatch } from '@domain/auth/auth-watch.js';
import { onLoginSuccess } from '@domain/auth/login-flow.js';
import { syncGatewayFromBackends } from '@domain/auth/gateway-sync.js';
import { createSessionRetentionController } from '@orch/session-retention-controller.js';

// Static imports are evaluated before this line, so this is how long module loading took.
const importsMs = Math.round(performance.now());

loadRuntimeDotenv(path.join(CONFIG_DIR, '.env'));
await migrateEnvToSettings();

// Ensure the WebSocket + webhook bearer tokens exist before either server starts. Generates
// and persists them to .env on first run (fail-closed auth — see core/auth.ts). Must run after
// runtime dotenv loading so pre-existing tokens are honored, before either server starts.
ensureAuthTokens();
if (!shouldSyncManagedStartupAssets()) {
  captureAuthTokensForRuntime({ scrubEnv: true });
}

// Project the saved credentials onto this process's env now that .env is loaded — the gateway
// child inherits them. Explicit here rather than at import, so CLI processes (cortex init /
// setup-gateway) importing the module don't get their env mutated. Mode routing is resolved per
// spawn, never here.
applyAuthEnv();
// The "daemon's Claude model" PI's subagent catalog and the MCP tool context read.
process.env.CORTEX_CLAUDE_MODEL = defaultClaudeModel();

// Resolve the UI language for all system-generated user-facing text. Precedence:
// CORTEX_LANG env (escape hatch, now that .env is loaded) > config/preferences.json > 'en'.
// The !lang command switches this live at runtime via setLocale().
setLocale(process.env.CORTEX_LANG ? normalizeLocale(process.env.CORTEX_LANG) : loadLang());

const log = createLogger('app');

function retentionLiveness(): RetentionLivenessSnapshot {
  return buildSessionRetentionLiveness({
    runningExecutions: runRegistry,
    bgHeldSessions: sessionHolds,
    interactionRecords,
    pendingDirectResumeSessionIds: pendingDirectTrackSessionIds(),
    activeClaudeCapturePaths: activeClaudeCaptureRegistry.listPaths(),
    activeClaudeCapturePairs: activeClaudeCaptureRegistry.listPairs(),
  });
}

async function runRetentionSweep(retentionDays: number, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const result = await runSessionRetentionSweep({
    retentionDays,
    signal,
    registry: sessionStore,
    ledgerRepo: conversationLedger,
    historyRepo: conversationHistory,
    candidateRepo: retentionCandidateRepo,
    liveness: retentionLiveness(),
    paths: {
      historyDir: CONVERSATION_HISTORY_DIR,
      piSessionsDir: path.join(DATA_DIR, 'logs', 'sessions-pi'),
      claudeCaptureDir: path.join(DATA_DIR, 'logs', 'sessions'),
      claudeProjectDir: getProjectDir(),
      toolImagesDir: TOOL_IMAGES_DIR,
    },
    syncClaudeUserCleanupPeriodDays,
  });
  // Inbound platform attachments are read during the turn they arrive on; nothing links to them
  // afterwards, and before this sweep existed they accumulated in the workspace forever.
  const attachmentsPruned = result.stopped ? 0 : await pruneInboundAttachments(retentionDays);
  log.info(`Retention sweep${result.stopped ? ' stopped early' : ''}: registry=${result.registryCommitted} history=${result.historyOrphanDeleted} pi=${result.piOrphanDeleted} capture=${result.claudeCaptureDeleted} toolImages=${result.toolImagesDeleted} attachments=${attachmentsPruned} errors=${result.errors.length} in ${Date.now() - startedAt}ms`);
}

const retentionController = createSessionRetentionController({
  getRetentionDays: () => getSettings().sessionRetentionDays,
  onSettingsChange,
  runSweep: runRetentionSweep,
  onError: (error) => log.error(`Retention sweep failed: ${error.message}`),
});

function initConfiguredHooks(): void {
  let entries: HookEntry[] = [];
  try {
    entries = loadHookRegistry();
  } catch (error) {
    log.error(`Startup: hook registry load failed: ${(error as Error).message}`);
  }
  initHookBus({ entries });
  const enabled = entries.filter((entry) => entry.enabled !== false);
  const ccCount = enabled.filter((entry) => entry.event.startsWith('cc:')).length;
  const cortexCount = enabled.filter((entry) => entry.event.startsWith('cortex:')).length;
  log.info(`Startup: mounted ${enabled.length} hooks (${ccCount} cc / ${cortexCount} cortex)`);
}

/** Preload the PI SDK at boot when any profile can route to it, so the first PI session of this
 *  process does not wait out its multi-second module import. */
function prewarmPiBackend(): void {
  try {
    const { profiles } = profileRepo.readSync();
    const usesPi = Object.values(profiles).some((profile) => profile.backend === 'pi'
      || profile.fallback?.some((entry) => entry.backend === 'pi'));
    if (usesPi) prewarmPiSdk();
  } catch (error) {
    log.warn(`Startup: PI preload skipped (profiles unreadable): ${(error as Error).message}`);
  }
}

// --- Singleton lock ---
// app.js owns ports 3001 (webhook) / 3002 (client-manager); a second instance would
// crash-loop on EADDRINUSE. The daemon's own daemon.pid lock only guards the supervisor
// layer and does nothing for `cortex start` (which forks app.js directly, bypassing the
// daemon). Acquire our own app.pid lock here, as early as possible, to fail fast before
// any heavy initialization or port binding. Stale locks (previous owner SIGKILL'd / crashed)
// are reclaimed automatically. Released on process exit (covers SIGTERM→exit(0) and Ctrl+C).
const APP_PID_FILE = path.join(STORE_DIR, 'app.pid');
const appLock = tryAcquireSingletonLock(APP_PID_FILE);
if (appLock.acquired) {
  if (appLock.stale) log.info(`Reclaimed stale app.pid lock for PID ${process.pid}`);
} else {
  log.error(
    `Another Cortex app.js is already running (PID ${appLock.holderPid}, lockfile ${APP_PID_FILE}).\n` +
    `         Refusing to start a second instance — it already holds ports 3001/3002; this process would crash on EADDRINUSE.\n` +
    `         Inspect with \`cortex daemon status\`, or stop the running instance before retrying.`,
  );
  process.exit(1);
}
process.on('exit', () => releaseSingletonLock(APP_PID_FILE));

// Cross-file migrations must finish before adapters, ports, and background services
// become externally visible. Provider-state extraction runs before schedule cleanup.
await runMigrations();
await migrateBuiltinJobSchedules();

// --- Crash safety net ---
// A single failed outbound post while handling an inbound message must never take
// down the whole server. Detached per-conduit queue work (conduit-queue.ts) and
// platform-adapter callbacks can reject without an observer; without these
// handlers an unhandled rejection terminates the process (exit code 1). Log the
// full stack and keep running. Mirrors the daemon's own guards (daemon.ts).
// Re-entrancy guard prevents an infinite loop if log.error() itself throws.
let _inExceptionHandler = false;
process.on('unhandledRejection', (reason) => {
  if (_inExceptionHandler) return;
  _inExceptionHandler = true;
  try {
    log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  } catch { /* swallow secondary failure */ } finally {
    _inExceptionHandler = false;
  }
});
process.on('uncaughtException', (err) => {
  if (_inExceptionHandler) return;
  _inExceptionHandler = true;
  try {
    log.error(`uncaughtException: ${err?.stack ?? err}`);
  } catch { /* swallow secondary failure */ } finally {
    _inExceptionHandler = false;
  }
});

// --- EventBus + logger ---
const bus = new EventBus();
createEventLogger(bus);
initAuthEvents(bus);
// A login only becomes useful once the models it unlocks are routable, and that mapping is derived
// by scanning local backend state. Re-derive it whenever a login lands, so a user who authenticates
// from the workbench gets working profiles without dropping to a terminal for `cortex setup-gateway`.
// Merge-aware and non-throwing (see gateway-sync.ts) — hand-edited profiles are never overwritten.
onLoginSuccess((event) => {
  void syncGatewayFromBackends({ backends: [event.backend] }).then((result) => {
    if (!result.configured && result.reason !== 'no-endpoints') {
      log.warn(`Gateway sync after ${event.backend} login did not complete: ${result.reason}`);
    }
  });
});
initHookBridge(bus); // S5: wire hook-bridge to publish ask-user.requested / plan.submitted
interactionRecords.init({ history: conversationHistory, bus }); // web-interactions-redesign: persistent interaction entities
// TTL expiry: mark the web interaction entity expired + clean the live resolver maps, so every
// connected client sees the card gray out (the entity resolve broadcasts session.interaction).
setOnStale((requestId, channel) => {
  if (!channel.startsWith('web:')) return;
  void interactionRecords.resolve({ id: requestId, status: 'expired', resolvedVia: 'timeout' });
  planApprovals.reject(requestId);
  askUserQuestion.deleteGroupByHookRequestId(requestId);
});
runRegistry.setBus(bus);   // S6-A: wire lifecycle events
// Web bg-hold snapshot: mirror every session.status event into the bg-held registry so
// sessions.list can serve the held state as a queryable snapshot (snapshot + delta).
bus.subscribe('session.status', (e) => sessionHolds.onSessionStatus(e));
planApprovals.setBus(bus);  // S6-A: wire plan.approved events
busyTracker.setBus(bus);    // S6-C: wire busy/idle IPC through event bus
initInteractionHandlers(bus); // BLK-1: wire ask-user.answered publisher

const TEMP_DIR = WORKSPACE_DIR;
mkdirSync(TEMP_DIR, { recursive: true });
mkdirSync(path.join(TEMP_DIR, 'threads'), { recursive: true });
ensurePIAgentDirs();

// --- Load machine registry (must happen before any module that uses getMachineRegistry()) ---
loadMachinesFromFile();
startMachineRegistryWatcher();

// --- Create platform adapter (replaces direct Slack App instantiation) ---
const adapter: PlatformAdapter = createHotReloadingAdapter();
// The one orchestration seam: orchestration reaches outward through an adapter and a bus it
// cannot construct, and is entered from places (a webhook, a scheduled job, a background run
// settling hours later) that hold neither. Everything under `orchestration/` reads them from
// here; `jobCtx.adapter/bus` below stays, but only for `domain/scheduling`'s own jobs.
setOrchestrationRuntime({ adapter, bus });
registerResumeWakeOnAgentSettle(bus, adapter);

// Wire injected dependencies into the TUI gateway before start() so it can
// resolve sessions during its own start()/handshake lifecycle.
const tuiGateway = extractTuiAdapter(adapter);
if (tuiGateway) {
  // Session lifecycle service (transport-agnostic; gateway delegates handshake/switch to it).
  tuiGateway.setSessionService(createTuiSessionService({ sessionStore, conversationLedger, conversationHistory }));
  // Conduit-queue port — MUST wrap the shared @orch/conduit-queue singletons so TUI message
  // work serializes with the rest of the pipeline on the same conduit key.
  tuiGateway.setConduitQueue({ enqueue, remove: (id) => conduitQueues.delete(id) });
  // Conduit resolver inversion: the registry's channel lookup resolves ephemeral TUI conduits
  // via the gateway's in-memory state (previously the gateway imported the store directly).
  sessionStore.registerConduitResolver((conduitId) => tuiGateway.lookupConduit(conduitId)?.sessionId ?? null);
}

// --- Wire hot-reload admin notifiers ---
const notifyAdmin = (text: string) => {
  void emitSystemNotice(adapter, { text });
};
setProfileNotifier(notifyAdmin);
setMachineNotifier(notifyAdmin);
setMachineReloadListener(() => {
  void releaseUnregisteredDevices().catch((e) => log.error(`Releasing removed machines failed: ${(e as Error).message}`));
});

// --- Init outbound message queue (WAL-based, survives restarts) ---
const oq = initOutboundQueue(adapter);

// --- Init extracted modules ---
initScheduledRunner(adapter);
// The `domain/scheduling` → `orchestration` seams: a schedule's fire hands its prompt to the
// session it opened as that session's first turn, and a fire that fails before a session exists
// says its one line through `notify`. Both are injected here because domain may not import
// orchestration.
jobCtx.notify = async (destination, text) => {
  const queue = getOutboundQueue();
  if (queue) { await durablePost(queue, adapter, destination, { text }); }
  else { await adapter.postMessage(destination, { text }); }
};
jobCtx.deliverScheduledTurn = ({ channel, text }) => deliverToSession({
  channel, text, origin: 'scheduled', tag: 'sched', adapter,
});
setBus(bus);
registerAuthWatch(bus, adapter, {
  buildPlatformAction: buildAuthRequiredLoginAction,
});
initAuthExpiryScan(buildAuthRequiredLoginAction);
const scheduler = createScheduler();
scheduler.setAdminNotifier(notifyAdmin);
// Rate-limit resume registry + throttle are initialized later, inside main(), as one ordered
// awaited sequence (initRateLimitRecovery).
initDiskMonitor(adapter);
// Agent sessions run in this process, so a stalled loop degrades all of them at once.
startEventLoopMonitor();

const commandRouter = new CommandActionRouter();

const dispatchCommand = registerCommands({
  scheduler,
  getExecutionStatusReport: buildExecutionStatusReport,
  compactSessionByChannel: compactActiveSessionContext,
  commandRouter,
  // `!lang` and the Web appearance toggle write the same knob; this lets a chat-side switch reach
  // every open SPA, which re-reads config.get on the event instead of holding a stale toggle.
  onLangChanged: () => bus.publish({ type: 'config.changed', section: 'preferences' }),
});

// DR-0013: wire Slack update prompt BEFORE bindToAdapter (router has no unregister API)
// The SPA dialog is the prompt users actually see; the chat-message prompt stays wired as the
// fallback createUiUpdatePrompt hands the question to when nobody answers the dialog in time
// (Slack/Feishu/headless installs have no SPA open).
const chatUpdatePrompt = createUpdatePrompt(adapter, commandRouter);
const updatePrompt = createUiUpdatePrompt(chatUpdatePrompt);
const serverUpdateCoordinator = createServerUpdateCoordinator({ prompt: updatePrompt });

// Bind command action handlers (buttons, modals) to the platform adapter
commandRouter.bindToAdapter(adapter);

const handleMessageEdit = createEditHandler({
  activeAgents: runRegistry,
  reprocessMessage,
  // Both backends pool their subprocess per channel, and an alive pooled process keeps the
  // conversation history in memory — it would ignore the rolled-back JSONL on disk. Close it
  // here so the next runAgent spawns a fresh process against the rewound transcript. The close
  // is backend-neutral and a no-op for a key with no live session.
  closePooledSession: (channel) => { void engines.close(channel); },
});

// --- Register interaction handlers ---
registerInteractionHandlers(adapter);

// --- Register message handler ---
registerMessageHandler(adapter, { dispatchCommand, handleMessageEdit });

// --- Profile watcher (hot-reload profiles.json without restart) ---
let _stopProfileWatcher: (() => void) | null = null;
// Web UI transport-host handle. The transport lives in-core (platform/ui-http) but is loaded on
// demand behind CORTEX_UI_HTTP; app.ts only ever calls close(), so a structural type keeps the
// composition root free of the transport's types (and of @trpc) on the static import graph.
let _uiHttpServer: { close: () => Promise<void> } | null = null;
let _platformConnections: PlatformConnections | null = null;

// --- Graceful shutdown ---
process.on('SIGTERM', async () => {
  void emitCortexEvent('cortex:server.shutdown', {
    version: CORTEX_VERSION,
    pid: process.pid,
    reason: 'SIGTERM',
  }).catch(() => {});
  await stopBuiltinJobs();
  await _platformConnections?.stop().catch(() => {});
  await retentionController.stop().catch(() => {});
  engines.closeAll(); await stopClientManager(); stopMachineRegistryWatcher(); _stopProfileWatcher?.();
  // A Chrome that outlives the daemon keeps the profile locked, so the next launch would attach to
  // an instance nothing is supervising.
  stopBrowser();
  // Device ports are loopback listeners held by this process; nothing reclaims them on its behalf.
  stopAllDevicePorts();
  // A device's Chrome is on someone else's machine and is not ours to kill on the way out; the next
  // acquire re-verifies, so leaving it running costs a window and nothing else.
  forgetDeviceBrowsers();
  await _uiHttpServer?.close().catch(() => {});
  stopDiskMonitor();
  stopEventLoopMonitor();
  // Stop scheduler timers BEFORE draining repo writes — otherwise a late-firing
  // timer can enqueue a mutate() after scheduleRepo.flush() resolves, losing that write.
  scheduler.stop();
  stopWaitpointSweep();
  // Stop outbound queue drain loop (pending WAL entries survive on disk for next startup).
  await oq.stop();
  // Drain in-flight atomic writes before exiting. Without this, SIGTERM landing between
  // `writeFile(tmp)` and `rename(tmp, target)` in atomic-write.ts leaves orphan .tmp.* siblings.
  // Daemon gives 5s before SIGKILL — well over the time needed to flush a few MB of JSON.
  try {
    await Promise.allSettled([bus.close(), oq.flush(), conversationLedger.flush(), conversationHistory.flush(), pendingInjectionRepo.flush(), teamOutboxRepo.flush(), executionRepo.flush(), projectDirRepo.flush(), waitpointRepo.flush(), scheduleRepo.flush(), providerStateRepo.flush(), costRepo.flush(), sessionStore.flush()]);
  } catch {}
  await stopGateway(); process.exit(0);
});

// --- Start ---
(async () => {
  const syncManagedAssets = shouldSyncManagedStartupAssets();
  if (syncManagedAssets) ensureMcpConfig();
  // Migrate old aistatus config from wrong location (CORTEX_HOME/config) to correct location (~/.aistatus)
  await migrateAistatusConfigLocation(DATA_DIR);
  // Refresh version-stamped hooks in DATA_DIR/hooks from the shipped defaults. Immutable trial
  // bundles already declare their entire role surface and may not mutate config after attestation.
  if (syncManagedAssets) await syncManagedHooks();
  initConfiguredHooks();
  // Deploy new plugins and refresh updated skills in DATA_DIR/plugins from the shipped defaults.
  // A sealed production trial declares no plugins and keeps its attested config immutable.
  if (syncManagedAssets) await syncManagedPlugins();
  // DR-0012 §3.6: clean up orphan TUI tmux sessions from a previous agent-server lifetime.
  // We can't re-adopt them (sessionKey↔tmux mapping was never persisted) so the honest move
  // is to kill any leftovers — otherwise a later session that reuses the same sessionId will
  // collide with `tmux new-session -s <name>` (which fails on duplicates).
  try {
    const { found, killed } = recoverTuiOrphans();
    if (found.length > 0) {
      log.info(`Startup: swept ${killed.length}/${found.length} orphan TUI tmux session(s)`);
    }
  } catch (e) {
    log.warn(`Startup: recoverTuiOrphans failed: ${(e as Error).message}`);
  }
  executionRepo.load();
  // An in-process execution dies with the server, so stale it immediately — otherwise a
  // 'running' dispatch record poisons a dispatch concurrency slot until the reconciler's next tick.
  await executionRegistry.markMissingRunningExecutionsStale();

  // A server restart closes every in-process injection window. Commit any durable orphan before
  // the UI transport starts so the first transcript snapshot cannot expose a forever-pending row.
  const recoveredPending = await recoverPendingInjections().catch((error) => {
    log.error(`recoverPendingInjections failed: ${(error as Error).message}`);
    return 0;
  });
  if (recoveredPending > 0) log.info(`Recovered ${recoveredPending} pending injected message(s)`);

  // A waitpoint that fired moments before shutdown has its wake still pending on disk, and the
  // signal spool may hold files written while the daemon was down. Reconcile both before anything
  // else can observe a session, on the same reasoning as the injection recovery above.
  const recoveredWaitpoints = await recoverWaitpoints();
  if (recoveredWaitpoints.delivered > 0 || recoveredWaitpoints.spooled > 0) {
    log.info(`Recovered ${recoveredWaitpoints.delivered} waitpoint wake(s), ${recoveredWaitpoints.spooled} spooled signal(s)`);
  }

  // ── Wire UI service into the TUI gateway ────────────────────────────────
  //
  // UI service (M3) provides store-backed query/mutate/subscribe capabilities
  // to the TUI gateway via a transport-agnostic facade.
  const uiService = createUiService({
    checkServerUpdate: () => serverUpdateCoordinator.check(),
    projectStore,
    sessionStore,
    scheduler: {
      list: () => scheduler.list(),
      get: (id) => scheduler.get(id),
      pause: (id, pausedBy) => scheduler.pause(id, pausedBy),
      resume: (id) => scheduler.resume(id),
      remove: (id) => scheduler.remove(id),
      // schedules.add: create via the real scheduler.add (timing math + persist), then backfill
      // target through the shared scheduleRepo singleton (buildTask drops it) — mirrors
      // domain/mcp/tools/schedule.ts::runScheduleAdd. scheduler._repo === scheduleRepo (default).
      add: async (type, options) => {
        const task = await scheduler.add(type, options);
        if (options.target) {
          await scheduleRepo.updateTask(task.id, (t) => {
            t.target = options.target;
          });
          return (await scheduleRepo.findTask(task.id)) ?? task;
        }
        return task;
      },
      update: (id, patch) => scheduler.update(id, patch),
    },
    executionRegistry,
    // Waitpoints (SessionInfo.waitingOn + the waitpoints.* ops). Injected here, at the entry layer,
    // so the ui-service domain never reaches into the waitpoint store. Only armed records are ever
    // listed: a settled waitpoint has already announced itself in the session transcript.
    waitpointRegistry: {
      listArmed: () => waitpointRepo.listArmed(),
      cancel: (id: string) => cancelWaitpoint(id),
    },
    approvalsPath: path.join(CONTEXT_DIR, 'PENDING_APPROVALS.md'),
    runningExecutions: sessionStates,
    costSummary: getCostSummary,
    conversationHistory,
    getSubagentChildStatuses,
    pendingInjections: pendingInjectionRepo,
    // S4 chat send: inject a genuine user turn into a session via the orchestration send path.
    // Injected here (entry layer) so the ui-service domain never imports orchestration.
    sendSessionMessage: ({ channel, text, attachments }) => deliverToSessionDetached({ channel, text, attachments, origin: 'web-user' }),
    // Machines screen: join static config (getMachineRegistry) + live WebSocket state (getOnlineDevices/
    // isDeviceOnline). Injected here (entry layer) so the ui-service domain never imports remote/.
    clientRegistry: {
      getOnlineDevices,
      isDeviceOnline,
      getMachineRegistry,
      // machines.detail expand: run the read-only telemetry probe over the existing client WebSocket.
      probeMachine: async (device, command, timeout) => {
        const result = await sendCommand(device, { action: 'bash', params: { command }, timeout });
        return typeof result?.stdout === 'string' ? result.stdout : '';
      },
    },
    // S4 chat Stop: cancel the agent(s) running on the session's channel via the orchestration
    // channel-cancel path (same code the no-arg/`--all` !cancel command uses). Injected here so the
    // ui-service domain never imports orchestration.
    cancelSessionRun: ({ channel }) => cancelChannelRuns(channel),
    cancelLiveExecution,
    // Manual context compact: both the Web mutation and !compact command share the idle-only
    // orchestration coordinator; sessions.list receives the matching display capability hint.
    supportsSessionCompaction: (session) => isSessionCompactionSupported(session),
    getSessionTodos: (sessionId) => sessionTodos.get(sessionId),
    compactSession: ({ sessionId }) => compactSessionContext(sessionId),
    // Message edit + rewind (sessions.rewind, desktop design 23 / mobile 7): roll the session back
    // to the edited turn and re-send. Injected here so the ui-service domain never imports
    // orchestration.
    rewindSession: (opts) => rewindWebSession({ ...opts, adapter }),
    // Workbench "+ New session": create a fresh live direct session. Wired here (entry layer) to the
    // domain primitive with the real session/ledger singletons, so ui-service never imports store.
    createDirectSession: (opts) => createDirectSession({
      sessionStore,
      setChannelSession: setSessionAsync,
      initConversation: async (channel, a) => { await conversationLedger.initConversation(channel, a); },
      resolveBackend: resolveBackendForChannel,
    }, opts),
    // Replying to a scheduled run (design 27b): adopt it as a normal direct session on its own
    // web:<sid> conduit before the send. Wired here so ui-service never imports the lifecycle.
    adoptScheduledSession: ({ sessionId }) => adoptScheduledSession(sessionStore, sessionId),
    // Web profile switch: apply the shared per-channel profile-switch rule (same one the Slack/Feishu
    // `!profile` command uses). Wired here so the ui-service domain never imports domain/agents.
    switchSessionProfile: (opts) => switchChannelProfile(opts),
    // Web agent picker: the same per-channel agent-switch rule the `!agent` command applies. A null
    // name is the "follow the global default" row, which clears the channel's selection instead.
    switchSessionAgent: async ({ channel, name }) => {
      if (name === null) {
        await clearChannelAgentSelection(channel);
        return { ok: true, agentName: null, effectiveProfile: getActiveProfile(channel) ?? '', backendChanged: false };
      }
      const res = await switchChannelAgent({ channel, name });
      return res.ok === true
        ? { ok: true, agentName: res.agentName, effectiveProfile: res.effectiveProfile, backendChanged: res.backendChanged }
        : {
          ok: false, agentName: null, effectiveProfile: '', backendChanged: false,
          reason: res.reason, currentBackend: res.currentBackend, targetBackend: res.targetBackend,
        };
    },
    // Web model picker: the composer's profile / model / provider / thinking choice, applied under
    // the one domain rule. Wired here for the same reason as the profile switch above.
    applySessionSelection: (opts) => applyChannelSelection(opts),
    getChannelSelectionOverride: (channel) => getChannelOverride(channel),
    // What a draft composer starts on before any session exists.
    getSelectionDefault: () => getSelectionDefault(),
    // Draft uploads are promoted into the newly-created session before its first turn is sent.
    moveDraftAttachments,
    bus,
    adapter,
    // Web UI: pending interactions for a channel (sessions.pendingInteraction query) —
    // served from the interaction entity index, so the plan card rehydrates with FULL content.
    getPendingAskUser: (channel) => {
      const entry = interactionRecords.getPendingByChannel(channel).find((e) => e.kind === 'ask-user');
      if (!entry) return null;
      // `blocking` distinguishes a session stalled on the answer from one that asked and kept
      // going (cortex_ask_user blocking:false) — only the former is "awaiting user action".
      return { requestId: entry.id, questions: entry.payload.questions ?? [], blocking: entry.payload.blocking !== false };
    },
    getPendingPlan: (channel) => {
      const entry = interactionRecords.getPendingByChannel(channel).find((e) => e.kind === 'plan-approval');
      if (!entry) return null;
      return { requestId: entry.id, planContent: entry.payload.planContent ?? '', planFilePath: entry.payload.planFilePath ?? null };
    },
    // Transcript materialization liveness signal (pending rows with no live entry derive to expired).
    isInteractionPending: (id) => interactionRecords.isPending(id),
    // Web UI ask-user-question: resolve a pending interaction by requestId. The MCP tool blocks
    // on the HTTP response; this callback collects answers, resolves the entity (which persists
    // the record and broadcasts session.interaction to every client), and unblocks the tool.
    answerQuestion: (requestId, answers) => answerQuestion(requestId, answers, 'web'),
    // Web UI plan-approval: resolve or reject a pending plan by requestId. First-writer-wins;
    // the entity resolve persists + broadcasts, so no separate history/session-message writes.
    respondPlan: (requestId, approved, feedback) => respondToPlan(
      { planApprovals, interactionRecords },
      requestId,
      approved,
      feedback,
      'web',
    ),
  });
  extractTuiAdapter(adapter)?.setUiService(uiService);

  // ── Web UI tRPC HTTP+SSE transport-host (opt-in via CORTEX_UI_HTTP) ──────
  // The Web UI transport (tRPC AppRouter + HTTP/SSE host + SPA serving) lives in-core under
  // platform/ui-http and pulls @trpc/server + jose. Core (Slack/TUI-only) must not load it: the
  // gate module does the CORTEX_UI_HTTP check and, only in the enabled branch, dynamic-imports the
  // transport — so an unset flag means @trpc/server + jose never enter the runtime graph. app.ts
  // statically imports only the import-free gate, keeping its static graph @trpc-free.
  try {
    _uiHttpServer = await startUiHttpIfEnabled(uiService);
  } catch (e) {
    log.warn(`CORTEX_UI_HTTP is set but the Web UI transport failed to load: ${(e as Error).message}`);
  }

  // Binds the TUI gateway; Slack/Feishu connect in the background with bounded retries, and a
  // platform that fails or stalls ends in a system notice rather than a stalled boot. Nothing below
  // needs their sockets: every outbound post, including the notices, goes through their HTTP APIs.
  _platformConnections = await startPlatformAdapters(adapter);

  // Let the supervisor reach the operator through us — it has no platform adapter of its own.
  subscribeDaemonNotices(adapter);

  void sendStartupDmIfConfigured(adapter, {
    machine: process.env.CORTEX_MACHINE,
    restartReason: process.env.CORTEX_RESTART_REASON,
  }).then((notified) => {
    if (!notified) log.info('Startup DM skipped: no admin channel configured.');
  }).catch((error) => log.warn(`Failed to send startup DM: ${(error as Error).message}`));

  // Recover unsent messages from WAL and start drain loop
  const recoveredCount = await oq.recover();
  if (recoveredCount > 0) {
    log.info(`OutboundQueue: recovered ${recoveredCount} pending messages from WAL`);
    oq.drain().catch(e => log.error(`OutboundQueue drain failed: ${(e as Error).message}`));
  }
  oq.startDrainLoop();

  // Execution environments: copy-if-missing the shipped defaults (a sealed trial home brings its
  // own), then load and watch config/environments/.
  if (syncManagedAssets) mergeDefaultEnvironments(DEFAULT_ENVIRONMENTS_DIR, ENVIRONMENTS_DIR);
  loadEnvironments();
  startEnvironmentWatcher();
  initializeProductionAttemptIdentity({
    configurationRevision: () => ({
      profiles: getProfileConfigRevision(), environments: getEnvironmentRevision(),
    }),
  });
  _stopProfileWatcher = startProfileWatcher(profileRepo, PROFILES_FILE, () => {
    bus.publish({ type: 'config.changed', section: 'profiles' });
  });
  await executionRepo.archiveTerminal().catch((e) => log.error(`Execution archive failed: ${(e as Error).message}`));

  // --- Rate-limit recovery (ordered) ---
  // 1) Hydrate the persisted resume queue. 2) Arm the throttle; its restart-recovery may fire
  //    onResume synchronously, draining the queue. 3) Evaluate any remaining entries against the
  //    restored active-provider set.
  await initResumeRegistry({
    save: (entries) => providerStateRepo.setResumeQueue(entries),
    load: () => providerStateRepo.getResumeQueue(),
  }, () => { bus.publish({ type: 'rate-limit.changed' }); }, async (entry) => {
    const bound = await getSessionAsync(entry.channel);
    return bound && await sessionStore.getById(bound) ? bound : null;
  });
  await initRateLimitThrottle(adapter, {
    save: (state) => providerStateRepo.setRateLimitThrottle(state),
    load: () => providerStateRepo.getRateLimitThrottle(),
  }, () => { void dispatchPendingResumes(adapter); },
  () => { bus.publish({ type: 'rate-limit.changed' }); });

  // Rate-limit notices carry a "Resume now" button (Slack/Feishu interactive). Clicking it
  // clears the throttle early for that provider (or all when the value is empty) and dispatches
  // paused work immediately — the same recovery path as a natural window expiry.
  adapter.onAction(RATE_LIMIT_CLEAR_ACTION_ID, async (ctx) => {
    const result = await clearThrottle(ctx.value || null);
    const conduit = ctx.messageRef?.conduit ?? '';
    const names = result.cleared.map((c) => c.displayName).join(', ');
    const text = result.cleared.length > 0
      ? `Rate limit cleared for ${names} — paused work is resuming now.`
      : 'No active rate limit to clear.';
    await adapter.postMessage(
      { type: 'interactive-reply', conduit, sessionId: '' },
      { text },
      { threadId: ctx.messageRef?.messageId },
    ).catch((e) => log.error(`rate-limit:clear reply failed: ${(e as Error).message}`));
  });
  if (getResumeCount() > 0) {
    log.info(`Startup: evaluating ${getResumeCount()} pending provider resume(s)`);
    await dispatchPendingResumes(adapter);
  }

  // The first sweep runs in the background so boot never waits on it; the session registry
  // serializes it against every other session mutation.
  retentionController.start();

  // M1: Initialize project registry (scaffolds general/, scans PROJECTS_DIR, starts fs.watch watcher)
  await projectStore.initialize();

  startGateway();
  prewarmPiBackend();
  startClientManager(parseInt(process.env.CORTEX_CLIENT_PORT || '3002', 10));

  startClientHotReloadJob(
    getSettings().clientHotReloadEnabled,
    () => initClientHotReload((text) => { void emitSystemNotice(adapter, { text }); }),
    startAllRemoteClients,
  );

  // DR-0013: server auto-update — first check after 60s, then every 24h.
  // Both timers are unref'd so they never hold the process open, and the default latest-version
  // probe is async (runFile), so neither blocks the event loop.
  const runUpdateCheck = async (): Promise<void> => {
    const result = await serverUpdateCoordinator.check();
    if (result.status === 'error') log.error(`Server auto-update check failed: ${result.reason}`);
  };
  const bootUpdateCheck = setTimeout(() => { void runUpdateCheck(); }, 60_000);
  bootUpdateCheck.unref?.();

  const dailyUpdateCheck = setInterval(() => { void runUpdateCheck(); }, 24 * 60 * 60 * 1000);
  dailyUpdateCheck.unref?.();

  await scheduler.start();

  // One-time migration: resume tasks left paused by the old scheduler-based rate-limit mechanism.
  // The new provider-aware rate-limit-throttle no longer pauses tasks via the scheduler guard.
  // Any tasks paused with pausedBy='rate-limit' by the old mechanism will never be resumed
  // unless we do it here on startup. Idempotent — on subsequent restarts no such tasks remain.
  for (const t of await scheduler.list()) {
    if (t.isPaused && t.pausedBy === 'rate-limit') {
      log.info(`Migration: resuming task ${t.id} ("${t.message}") paused by old rate-limit mechanism`);
      await scheduler.resume(t.id);
    }
  }

  // Daily store archival: move week-old terminal execution records to data/archive/*.jsonl.
  // Keeps the hot stores small — their full-map sync stringify on every persist is the main
  // event-loop stall source when they grow to multi-MB.
  startStoreArchiveJob(getSettings().storeArchiveEnabled, async () => {
    try {
      await executionRepo.archiveTerminal();
    } catch (e) {
      log.error(`Daily store archive failed: ${(e as Error).message}`);
    }
  });

  startWebhookServer();

  // S13: register hook-bridge event subscribers (bodies extracted to orch/routing/hook-bridge-subscribers.ts)
  registerHookBridgeSubscribers(bus, adapter, planApprovals);
  installTeamDelivery(bus);
  // Worker reports a restart kept from their leads: delivered now that sessions and the adapter are up.
  void flushTeamOutbox()
    .then((n) => { if (n > 0) log.info(`Delivered ${n} worker report(s) kept across the restart`); })
    .catch((error) => log.error(`Team outbox flush failed: ${(error as Error).message}`));

  // The same seam for PI's in-process `agent`: registering a background run reaches the delivery
  // route above, so the adapter declares the port (D10) and the composition root fills it.
  setPiBackgroundSubagentBridge({ startBackgroundSubagent, stopBackgroundSubagent });

  startMemoryWatcher();

  // Waitpoints: drains the signal spool, ages out expired waitpoints and retries any wake whose
  // delivery failed. Every in-memory fast path dies with the process; this does not.
  startWaitpointSweep();
  startBuiltinJobs(adapter);

  void emitCortexEvent('cortex:server.start', {
    version: CORTEX_VERSION,
    pid: process.pid,
  }).catch(() => {});
  // D5: there is no global backend any more — the default profile's is what a channel with no
  // selection of its own will use, and that is what belongs in the banner.
  const bootConfig = resolveRunConfig();
  log.info(
    `Cortex agent is running (${adapter.name}) — profile: ${bootConfig.profileName}`
    + ` · backend: ${bootConfig.profile.backend}`
    + ` · boot ${Math.round(performance.now())}ms (imports ${importsMs}ms)`,
  );
})();
