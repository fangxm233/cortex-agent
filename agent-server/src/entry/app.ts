// input:  .env, PlatformAdapter, stores, orchestration modules, provider throttle state
// output: server wiring with provider-scoped throttle recovery
// pos:    agent-server main entry and wiring hub
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import * as dotenv from 'dotenv';
import { mkdirSync, promises as fsPromises } from 'fs';
import * as path from 'path';
import { createAdapterFromEnv, extractTuiAdapter } from '@platform/index.js';
import type { PlatformAdapter } from '@platform/index.js';
// Gate for the in-core Web UI transport: static import is @trpc-free (node builtins + an erased
// type only); the transport (which pulls @trpc/server + jose) is dynamic-imported inside the gate,
// gated on CORTEX_UI_HTTP, so it stays runtime-lazy for Slack/TUI-only installs.
import { startUiHttpIfEnabled } from '@entry/ui-http-gate.js';
import { WORKSPACE_DIR, CONFIG_DIR, DATA_DIR, STORE_DIR, DEFAULTS_DIR, CONTEXT_DIR } from '@core/utils.js';
import { tryAcquireSingletonLock, releaseSingletonLock } from '@core/singleton-lock.js';
import { closeAllSessions, closeSession as closeClaudePooledSession, shutdownCodex } from '@domain/agents/index.js';
import { closeAllAdapters } from '../agent-adapter/index.js';
import { recoverTuiOrphans } from '../agent-adapter/claude/adapter.js';
import { startWebhookServer } from '@orch/routing/webhook.js';
import * as pendingTaskTracker from '@domain/tasks/pending-tracker.js';
import * as executionRegistry from '@domain/executions/registry.js';
import { executionLogTailer } from '@domain/executions/log-tailer.js';
import { initHookBridge, resolveRequest as resolveHookRequest, setOnStale } from '@orch/routing/hook-bridge.js';
import { interactionRecords } from '@orch/interactions/interaction-records.js';
import * as askUserQuestion from '@orch/interactions/ask-user-question.js';
import { registerCommands } from '@orch/routing/commands/index.js';
import { cancelChannelRuns } from '@orch/routing/commands/cancel.js';
import { taskStore } from '@domain/tasks/store.js';
import { taskMutator } from '@domain/tasks/mutator.js';
import { recoverOrphanedClaims } from '@domain/tasks/claim-recovery.js';
import { projectDirRepo } from '@store/project-dir-repo.js';
import { projectStore } from '@domain/projects/index.js';
import { sendStartupDmIfConfigured } from './startup-notify.js';
import { startGateway, stopGateway } from '@domain/costs/gateway-manager.js';
import { startClientManager, stopClientManager, startAllRemoteClients, getOnlineDevices, isDeviceOnline } from '@domain/remote/client-manager.js';
import { checkAndUpdateClients, formatUpdateSlackMessage } from '@domain/remote/client-hot-reload.js';
import { checkServerUpdate } from '@domain/system/server-update-check.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { threadStore } from '@store/thread-repo.js';
import { sessionRepo, registerConduitProvider } from '@store/session-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { conversationHistory } from '@store/conversation-history-repo.js';
import { pendingInjectionRepo } from '@store/pending-injection-repo.js';
import { executionRepo } from '@store/execution-repo.js';
import { loadConfig as loadThreadConfig, startConfigWatcher as startThreadConfigWatcher, setAdminNotifier as setConfigNotifier, migrateThreadTemplatesToDir, mergeThreadTemplates } from '@domain/threads/index.js';
import { startMemoryWatcher } from '@domain/memory/watcher.js';
import { getActiveBackend, configureEnvForMode, loadMode } from '@domain/agents/index.js';
import { createEditHandler } from '@orch/routing/edit-handler.js';
import { setLocale, normalizeLocale } from '@core/i18n.js';
import { loadLang } from '@domain/system/preferences.js';

// Extracted modules
import { cleanupLogs, ensureMcpConfig } from './startup-helpers.js';
import { createLogger } from '@core/log.js';
import { ensureAuthTokens } from '@core/auth.js';
import { runningExecutions } from '@core/running-executions.js';
import { bgHeldSessions } from '@core/bg-held-sessions.js';
import { planApprovals } from '@orch/interactions/plan-approvals.js';
import { busyTracker } from '@orch/busy-tracker.js';
import { buildExecutionStatusReport } from '@orch/status-helpers.js';
import { reprocessMessage } from '@orch/lifecycle.js';
import { initScheduledRunner, createScheduler, setSchedulerRef, setBus, setInteractiveCallbacksFactory, cancelDispatchedTask } from '@domain/scheduling/runner.js';
import { recoverWaitingThreads, registerTaskTreeSubscribers, reconcileWaitingTasks, startWaitingManagerSweep } from '../orchestration/thread-callback.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { buildInteractiveCallbacks } from '@orch/agent-runner.js';
import { registerInteractionHandlers, initInteractionHandlers } from '@orch/interactions/interaction-handlers.js';
import { respondToPlan } from '@orch/interactions/plan-response.js';
import { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { createUpdatePrompt } from '@orch/interactions/update-prompt.js';
import { registerMessageHandler } from '@orch/routing/message-router.js';
import { initRateLimitThrottle } from '@domain/costs/rate-limit-throttle.js';
import { initResumeRegistry, getResumeCount, recordResume } from '@domain/costs/resume-registry.js';
import { dispatchPendingResumes } from '../orchestration/resume-dispatcher.js';
import { scheduleRepo } from '@store/schedule-repo.js';
import { runMigrations, migrateAistatusConfigLocation } from '@store/version-migrations.js';
import { syncManagedHooks } from '@store/hook-sync.js';
import { syncManagedPlugins } from '@store/plugin-sync.js';
import { costRepo } from '@store/cost-repo.js';
import { PROFILES_FILE, profileRepo, startProfileWatcher, setAdminNotifier as setProfileNotifier } from '@store/profile-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { cleanupAllBackups } from '@domain/sessions/session-backup.js';
import { createDirectSession } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { isSessionCompactionSupported, resolveBackendForChannel, switchChannelProfile } from '@domain/agents/index.js';
import { initDiskMonitor, stopDiskMonitor } from '@domain/monitor/disk-monitor.js';
import { loadMachinesFromFile, startMachineRegistryWatcher, stopMachineRegistryWatcher, setAdminNotifier as setMachineNotifier, getMachineRegistry } from '@domain/tasks/dispatch-utils.js';
import { EventBus, createEventLogger } from '@events/index.js';
import { registerHookBridgeSubscribers } from '@orch/routing/hook-bridge-subscribers.js';
import { startDispatchReconciler } from '@orch/dispatch-reconciler.js';
import { ensurePIAgentDirs } from '../agent-adapter/pi/agent-dir.js';
import { initOutboundQueue, getOutboundQueue } from '@store/outbound-queue.js';
import { createUiService } from '@domain/ui-service/index.js';
import { sendWebUserMessage } from '../orchestration/session-send.js';
import { rewindWebSession } from '../orchestration/session-rewind.js';
import { compactActiveSessionContext, compactSessionContext } from '../orchestration/session-compact.js';
import { recoverPendingInjections } from '../orchestration/pending-injection-recovery.js';
import { createTuiSessionService } from '@domain/tui-session/index.js';
import { enqueue, conduitQueues } from '@orch/conduit-queue.js';
import { getCostSummary } from '@domain/costs/cost-tracker.js';

dotenv.config({ path: path.join(CONFIG_DIR, '.env') });

// Ensure the WebSocket + webhook bearer tokens exist before either server starts. Generates
// and persists them to .env on first run (fail-closed auth — see core/auth.ts). Must run after
// dotenv.config() so pre-existing tokens are honored, and before startClientManager/startWebhookServer.
ensureAuthTokens();

// Apply the persisted mode to env now that .env is loaded. This used to be an import-time
// side effect inside domain/agents/config.ts; it is explicit here so that CLI processes
// (cortex init / setup-gateway) importing that module don't get their env mutated.
configureEnvForMode(loadMode());

// Resolve the UI language for all system-generated user-facing text. Precedence:
// CORTEX_LANG env (escape hatch, now that .env is loaded) > config/preferences.json > 'en'.
// The !lang command switches this live at runtime via setLocale().
setLocale(process.env.CORTEX_LANG ? normalizeLocale(process.env.CORTEX_LANG) : loadLang());

const log = createLogger('app');

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
runningExecutions.setBus(bus);   // S6-A: wire lifecycle events
// Web bg-hold snapshot: mirror every session.status event into the bg-held registry so
// sessions.list can serve the held state as a queryable snapshot (snapshot + delta).
bus.subscribe('session.status', (e) => bgHeldSessions.onSessionStatus(e));
planApprovals.setBus(bus);  // S6-A: wire plan.approved events
busyTracker.setBus(bus);    // S6-C: wire busy/idle IPC through event bus
taskMutator.setBus(bus);    // c39d: wire task lifecycle events
executionLogTailer.setBus(bus); // 342f: wire execution.log live log-tail stream
initInteractionHandlers(bus); // BLK-1: wire ask-user.answered publisher

const TEMP_DIR = WORKSPACE_DIR;
mkdirSync(TEMP_DIR, { recursive: true });
mkdirSync(path.join(TEMP_DIR, 'threads'), { recursive: true });
ensurePIAgentDirs();

// --- Load machine registry (must happen before any module that uses getMachineRegistry()) ---
loadMachinesFromFile();
startMachineRegistryWatcher();

// --- Create platform adapter (replaces direct Slack App instantiation) ---
const adapter: PlatformAdapter = createAdapterFromEnv();

// Wire EventBus + injected dependencies into the TUI gateway before start() so it can
// subscribe to bus events and resolve sessions during its own start()/handshake lifecycle.
const tuiGateway = extractTuiAdapter(adapter);
if (tuiGateway) {
  tuiGateway.setBus(bus);
  // Session lifecycle service (transport-agnostic; gateway delegates handshake/switch to it).
  tuiGateway.setSessionService(createTuiSessionService({ sessionStore, conversationLedger, conversationHistory }));
  // Conduit-queue port — MUST wrap the shared @orch/conduit-queue singletons so TUI message
  // work serializes with the rest of the pipeline on the same conduit key.
  tuiGateway.setConduitQueue({ enqueue, remove: (id) => conduitQueues.delete(id) });
  // Conduit provider inversion: store-layer session lookup resolves ephemeral TUI conduits
  // via the gateway's in-memory state (previously the gateway imported the store directly).
  registerConduitProvider((conduitId) => tuiGateway.lookupConduit(conduitId));
}

// --- Wire hot-reload admin notifiers ---
const notifyAdmin = (text: string) => {
  void emitSystemNotice(adapter, { text });
};
setProfileNotifier(notifyAdmin);
setConfigNotifier(notifyAdmin);
setMachineNotifier(notifyAdmin);

// --- Init outbound message queue (WAL-based, survives restarts) ---
const oq = initOutboundQueue(adapter);

// --- Init extracted modules ---
initScheduledRunner(adapter);
setBus(bus);
setInteractiveCallbacksFactory(buildInteractiveCallbacks);
const scheduler = createScheduler();
scheduler.setAdminNotifier(notifyAdmin);
setSchedulerRef(scheduler);
// Rate-limit resume registry + throttle are initialized later, inside main(), as one ordered
// awaited sequence (initRateLimitRecovery) — it must run AFTER threadStore.load() so it can
// reconcile orphaned rate-limited threads back into the resume queue.
initDiskMonitor(adapter);

const commandRouter = new CommandActionRouter();

const dispatchCommand = registerCommands({
  scheduler,
  cancelDispatchedTask,
  getExecutionStatusReport: buildExecutionStatusReport,
  compactSessionByChannel: compactActiveSessionContext,
  commandRouter,
});

// DR-0013: wire Slack update prompt BEFORE bindToAdapter (router has no unregister API)
const updatePrompt = createUpdatePrompt(adapter, commandRouter);

// Bind command action handlers (buttons, modals) to the platform adapter
commandRouter.bindToAdapter(adapter);

const handleMessageEdit = createEditHandler({
  activeAgents: runningExecutions,
  reprocessMessage,
  // Claude CLI runs in stream-json mode and pools the subprocess per channel; an alive
  // pooled process keeps the conversation history in memory and ignores the rolled-back
  // JSONL on disk. Close it here so the next runAgent spawns a fresh process with
  // `--resume <sessionId>`. PI/codex spawn fresh subprocesses per turn, so the close is
  // a no-op for them (we still call through for symmetry — adapter exits early when
  // there's nothing to close).
  closePooledSession: (channel, backend) => {
    if (backend === 'claude') closeClaudePooledSession(channel);
  },
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

// --- Graceful shutdown ---
process.on('SIGTERM', async () => {
  closeAllSessions(); shutdownCodex(); closeAllAdapters().catch(() => {}); stopClientManager(); stopMachineRegistryWatcher(); _stopProfileWatcher?.();
  await _uiHttpServer?.close().catch(() => {});
  stopDiskMonitor();
  // Stop scheduler timers BEFORE draining repo writes — otherwise a late-firing
  // timer can enqueue a mutate() after scheduleRepo.flush() resolves, losing that write.
  scheduler.stop();
  // Stop outbound queue drain loop (pending WAL entries survive on disk for next startup).
  await oq.stop();
  // Drain in-flight atomic writes before exiting. Without this, SIGTERM landing between
  // `writeFile(tmp)` and `rename(tmp, target)` in atomic-write.ts leaves orphan .tmp.* siblings.
  // Daemon gives 5s before SIGKILL — well over the time needed to flush a few MB of JSON.
  try {
    await Promise.allSettled([bus.close(), oq.flush(), threadStore.flush(), sessionRepo.flush(), conversationLedger.flush(), conversationHistory.flush(), pendingInjectionRepo.flush(), taskStore.flush(), executionRepo.flush(), projectDirRepo.flush(), scheduleRepo.flush(), costRepo.flush(), profileRepo.flush(), sessionStore.flush()]);
  } catch {}
  await stopGateway(); process.exit(0);
});

// --- Start ---
(async () => {
  cleanupLogs();
  ensureMcpConfig();
  await runMigrations();
  // Migrate old aistatus config from wrong location (CORTEX_HOME/config) to correct location (~/.aistatus)
  await migrateAistatusConfigLocation(DATA_DIR);
  // Refresh version-stamped hooks in DATA_DIR/hooks from the shipped defaults. init's deployHooks
  // only copies-if-missing, so without this an existing install never picks up hook code fixes.
  await syncManagedHooks();
  // Deploy new plugins and refresh updated skills in DATA_DIR/plugins from the shipped defaults.
  // init's copyDefaults (copy-if-missing, only on `cortex init`) never reaches an existing install,
  // so without this a new plugin or an updated skill never propagates on upgrade.
  await syncManagedPlugins();
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
  // Keep only REMOTE dispatch running across restart (it runs on another machine/tmux and
  // survives). An in-process dispatch (dispatch=null / machine 'local') dies with the server, so
  // stale it immediately — otherwise its 'running' record poisons a dispatch concurrency slot
  // until the reconciler's next tick.
  await executionRegistry.markMissingRunningExecutionsStale(
    (record) => record.kind === 'dispatch' && !!record.dispatch?.machine && record.dispatch.machine !== 'local',
  );

  // A server restart closes every in-process injection window. Commit any durable orphan before
  // the UI transport starts so the first transcript snapshot cannot expose a forever-pending row.
  const recoveredPending = await recoverPendingInjections().catch((error) => {
    log.error(`recoverPendingInjections failed: ${(error as Error).message}`);
    return 0;
  });
  if (recoveredPending > 0) log.info(`Recovered ${recoveredPending} pending injected message(s)`);

  // ── Wire UI service into the TUI gateway ────────────────────────────────
  //
  // UI service (M3) provides store-backed query/mutate/subscribe capabilities
  // to the TUI gateway via a transport-agnostic facade.
  const uiService = createUiService({
    projectStore,
    sessionStore,
    threadStore,
    taskStore,
    scheduler: {
      list: () => scheduler.list(),
      get: (id) => scheduler.get(id),
      pause: (id, pausedBy) => scheduler.pause(id, pausedBy),
      resume: (id) => scheduler.resume(id),
      remove: (id) => scheduler.remove(id),
      // schedules.add: create via the real scheduler.add (timing math + persist), then backfill
      // target/fallback through the shared scheduleRepo singleton (buildTask drops them) — mirrors
      // domain/mcp/tools/schedule.ts::runScheduleAdd. scheduler._repo === scheduleRepo (default).
      add: async (type, options) => {
        const task = await scheduler.add(type, options);
        if (options.target || options.fallback) {
          await scheduleRepo.updateTask(task.id, (t) => {
            if (options.target) t.target = options.target;
            if (options.fallback) t.fallback = options.fallback;
          });
          return (await scheduleRepo.findTask(task.id)) ?? task;
        }
        return task;
      },
    },
    executionRegistry,
    executionLogTailer,
    approvalsPath: path.join(CONTEXT_DIR, 'PENDING_APPROVALS.md'),
    runningExecutions,
    costSummary: getCostSummary,
    conversationHistory,
    pendingInjections: pendingInjectionRepo,
    // S4 chat send: inject a genuine user turn into a session via the orchestration send path.
    // Injected here (entry layer) so the ui-service domain never imports orchestration.
    sendSessionMessage: ({ channel, text, attachments }) => sendWebUserMessage({ channel, text, attachments, adapter }),
    // Machines screen: join static config (getMachineRegistry) + live WebSocket state (getOnlineDevices/
    // isDeviceOnline). Injected here (entry layer) so the ui-service domain never imports remote/.
    clientRegistry: {
      getOnlineDevices,
      isDeviceOnline,
      getMachineRegistry,
    },
    // S4 chat Stop: cancel the agent(s) running on the session's channel via the orchestration
    // channel-cancel path (same code the no-arg/`--all` !cancel command uses). Injected here so the
    // ui-service domain never imports orchestration.
    cancelSessionRun: ({ channel }) => cancelChannelRuns(channel),
    // Manual context compact: both the Web mutation and !compact command share the idle-only
    // orchestration coordinator; sessions.list receives the matching display capability hint.
    supportsSessionCompaction: (session) => isSessionCompactionSupported(session),
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
    // Web profile switch: apply the shared per-channel profile-switch rule (same one the Slack/Feishu
    // `!profile` command uses). Wired here so the ui-service domain never imports domain/agents.
    switchSessionProfile: (opts) => switchChannelProfile(opts),
    // Draft attachment migration: when a draft session is created with uploaded files, move
    // them from the temporary draft directory to the real session's attachment directory.
    moveDraftAttachments: async ({ draftUploadId, sessionId, attachments }) => {
      if (!draftUploadId) return attachments;
      const srcDir = path.join(WORKSPACE_DIR, 'attachments', draftUploadId);
      const dstDir = path.join(WORKSPACE_DIR, 'attachments', sessionId);
      try {
        await fsPromises.mkdir(dstDir, { recursive: true });
        return await Promise.all(attachments.map(async (a) => {
          const srcPath = path.join(srcDir, a.path.split('/').slice(2).join('/'));
          const fileName = a.path.split('/').pop() || a.name;
          const dstPath = path.join(dstDir, fileName);
          try {
            await fsPromises.rename(srcPath, dstPath);
          } catch {
            // File may already be moved or missing — keep the original path.
          }
          return { ...a, path: `attachments/${sessionId}/${fileName}` };
        }));
      } catch {
        // Best-effort — if the move fails, the original paths still work if the draft dir
        // hasn't been cleaned up yet.
        return attachments;
      }
    },
    bus,
    adapter,
    // Web UI: pending interactions for a channel (sessions.pendingInteraction query) —
    // served from the interaction entity index, so the plan card rehydrates with FULL content.
    getPendingAskUser: (channel) => {
      const entry = interactionRecords.getPendingByChannel(channel).find((e) => e.kind === 'ask-user');
      if (!entry) return null;
      return { requestId: entry.id, questions: entry.payload.questions ?? [] };
    },
    getPendingPlan: (channel) => {
      const entry = interactionRecords.getPendingByChannel(channel).find((e) => e.kind === 'plan-approval');
      if (!entry) return null;
      return { requestId: entry.id, planContent: entry.payload.planContent ?? '', planFilePath: entry.payload.planFilePath ?? null };
    },
    // Transcript materialization liveness signal (pending rows with no live entry derive to expired).
    isInteractionPending: (id) => interactionRecords.isPending(id),
    // Web bg-hold snapshot: sessions.list serves the held state so it survives session switches /
    // app restarts (the registry mirrors session.status events — subscribed at the bus wiring above).
    isSessionBgHeld: (sessionId) => bgHeldSessions.has(sessionId),
    // Web UI ask-user-question: resolve a pending interaction by requestId. The MCP tool blocks
    // on the HTTP response; this callback collects answers, resolves the entity (which persists
    // the record and broadcasts session.interaction to every client), and unblocks the tool.
    answerQuestion: (requestId, answers) => {
      const rec = interactionRecords.get(requestId);
      if (rec && rec.status !== 'pending') return 'already-resolved';
      const group = askUserQuestion.getGroupByHookRequestId(requestId);
      if (!group) {
        // No group (raw hook request) — unblock the webhook directly if it exists.
        if (!resolveHookRequest(requestId, { answers })) return 'not-found';
        void interactionRecords.resolve({ id: requestId, status: 'answered', result: { answers }, resolvedVia: 'web' });
        return 'resolved';
      }
      for (const q of group.questions) {
        const answer = answers[q.question];
        if (answer !== undefined) {
          group.answers.set(q.pendingId, { header: q.header, value: answer });
        }
      }
      if (!askUserQuestion.tryResolveHook(group)) return 'not-found';
      void interactionRecords.resolve({ id: requestId, status: 'answered', result: { answers }, resolvedVia: 'web' });
      return 'resolved';
    },
    // Web UI plan-approval: resolve or reject a pending plan by requestId. First-writer-wins;
    // the entity resolve persists + broadcasts, so no separate history/session-message writes.
    respondPlan: (requestId, approved, feedback) => respondToPlan(
      { planApprovals, interactionRecords },
      requestId,
      approved,
      feedback,
    ),
  });
  extractTuiAdapter(adapter)?.setUiService(uiService);

  // ── Web UI tRPC HTTP+SSE transport-host (opt-in via CORTEX_UI_HTTP) ──────
  // The Web UI transport (tRPC AppRouter + HTTP/SSE host + SPA serving) lives in-core under
  // platform/ui-http and pulls @trpc/server + jose. Core (Slack/TUI-only) must not load it: the
  // gate module does the CORTEX_UI_HTTP check and, only in the enabled branch, dynamic-imports the
  // transport — so an unset flag means @trpc/server + jose never enter the runtime graph. app.ts
  // statically imports only the gate (node builtins + an erased type), keeping its static graph
  // @trpc-free (guarded by tests/platform/ui-http-lazy-load.test.ts).
  try {
    _uiHttpServer = await startUiHttpIfEnabled(uiService);
  } catch (e) {
    log.warn(`CORTEX_UI_HTTP is set but the Web UI transport failed to load: ${(e as Error).message}`);
  }

  await adapter.start();

  try {
    const notified = await sendStartupDmIfConfigured(adapter, {
      machine: process.env.CORTEX_MACHINE,
      restartReason: process.env.CORTEX_RESTART_REASON,
    });
    if (!notified) log.info('Startup DM skipped: no admin channel configured.');
  } catch (error) {
    log.warn(`Failed to send startup DM: ${(error as Error).message}`);
  }

  // Recover unsent messages from WAL and start drain loop
  const recoveredCount = await oq.recover();
  if (recoveredCount > 0) {
    log.info(`OutboundQueue: recovered ${recoveredCount} pending messages from WAL`);
    oq.drain().catch(e => log.error(`OutboundQueue drain failed: ${(e as Error).message}`));
  }
  oq.startDrainLoop();

  pendingTaskTracker.init(adapter);
  taskStore.load();

  // DR-0017 D6 Phase 2.5: migrate a legacy single thread-templates.json to the directory form,
  // then per-file copy-if-missing the shipped defaults dir (so new agents/templates/shells — e.g.
  // a new shell definition — reach existing installs). Both run before loadThreadConfig.
  migrateThreadTemplatesToDir();
  mergeThreadTemplates(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadThreadConfig();
  startThreadConfigWatcher();
  _stopProfileWatcher = startProfileWatcher(profileRepo, PROFILES_FILE, () => {
    bus.publish({ type: 'config.changed', section: 'profiles' });
  });
  threadStore.load();
  await threadStore.markRunningAsFailedOnStartup();
  await threadStore.cleanup();

  // Crash-orphan claim recovery: a dispatch claim whose owner died with the server keeps the
  // task invisible to the dispatcher forever (claimed → not actionable → never re-dispatched),
  // stranding it and any manager suspended on it. Runs after markRunningAsFailedOnStartup so
  // surviving waiting/rate_limited threads still protect their claims; remote cortex-run tasks
  // (status pending / pending-tracker) and manual claims are respected. Before scheduler.start
  // so recovered tasks are back in the queue for the first dispatch cycle.
  await recoverOrphanedClaims().catch((e) => log.error(`recoverOrphanedClaims failed: ${(e as Error).message}`));

  // --- Rate-limit recovery (ordered; must run after threadStore.load) ---
  // 1) hydrate the persisted resume queue. 2) Reconcile orphaned rate-limited threads: any thread
  //    left in 'rate_limited' (markRunningAsFailedOnStartup deliberately spares them) that is not
  //    represented in the queue — dropped by a prior dispatcher skip, or a queue/throttle desync
  //    across restart — is re-queued (idempotent, dedupe by threadId). 3) Arm the throttle; its
  //    restart-recovery may fire onResume synchronously, draining the (already-reconciled) queue.
  //    4) Evaluate any remaining entries against the restored active-provider set.
  await initResumeRegistry({
    save: (entries) => scheduleRepo.setResumeQueue(entries),
    load: () => scheduleRepo.getResumeQueue(),
  }, () => { bus.publish({ type: 'rate-limit.changed' }); });
  let reQueuedRateLimited = 0;
  for (const t of threadStore.getAll()) {
    if (t.status === 'rate_limited') {
      recordResume({
        kind: 'thread', provider: t.metadata?.rateLimitProvider ?? null,
        threadId: t.id, channel: t.channel,
        userMessage: t.userMessage ?? '', recordedAt: Date.now(),
      });
      reQueuedRateLimited++;
    }
  }
  if (reQueuedRateLimited > 0) log.info(`Reconciled ${reQueuedRateLimited} rate-limited thread(s) into the resume queue`);
  await initRateLimitThrottle(adapter, {
    save: (state) => scheduleRepo.setRateLimitThrottle(state),
    load: () => scheduleRepo.getRateLimitThrottle(),
  }, () => { void dispatchPendingResumes(adapter); },
  () => { bus.publish({ type: 'rate-limit.changed' }); });
  if (getResumeCount() > 0) {
    log.info(`Startup: evaluating ${getResumeCount()} pending provider resume(s)`);
    void dispatchPendingResumes(adapter);
  }

  // GC: prune stale sessions (older than 7 days, unreferenced by running executions or active threads)
  sessionStore.setOnPruneSession(cleanupAllBackups);
  try {
    const pruned = await sessionStore.pruneStale(7 * 24 * 60 * 60 * 1000);
    if (pruned > 0) log.info(`Startup GC: pruned ${pruned} stale session(s)`);
  } catch (e) {
    log.warn(`Startup GC: pruneStale failed: ${(e as Error).message}`);
  }

  // M1: Initialize project registry (scaffolds general/, scans PROJECTS_DIR, starts fs.watch watcher)
  await projectStore.initialize();

  startGateway();
  startClientManager(parseInt(process.env.CORTEX_CLIENT_PORT || '3002', 10));

  setTimeout(async () => {
    try {
      const updateResult = await checkAndUpdateClients();
      if (updateResult) {
        log.info(`Client hot-reload: ${updateResult.devices.length} devices updated in ${updateResult.duration}ms`);
        await emitSystemNotice(adapter, { text: formatUpdateSlackMessage(updateResult) });
      }
    } catch (e) {
      log.error(`Client hot-reload check failed: ${(e as Error).message}`);
    }
    await startAllRemoteClients();
  }, 2000);

  // DR-0013: server auto-update — first check after 60s, then every 24h
  setTimeout(async () => {
    try {
      await checkServerUpdate({ prompt: updatePrompt });
    } catch (e) {
      log.error(`Server auto-update check failed: ${(e as Error).message}`);
    }
  }, 60_000);

  setInterval(async () => {
    try {
      await checkServerUpdate({ prompt: updatePrompt });
    } catch (e) {
      log.error(`Server auto-update check failed: ${(e as Error).message}`);
    }
  }, 24 * 60 * 60 * 1000);

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

  // Periodic GC for stale sessions (every 6 hours)
  const PRUNE_STALE_INTERVAL = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const removed = await sessionStore.pruneStale(7 * 24 * 60 * 60 * 1000);
      if (removed > 0) log.info(`Periodic GC: pruned ${removed} stale session(s)`);
    } catch (e) {
      log.error(`Periodic GC: pruneStale failed: ${(e as Error).message}`);
    }
  }, PRUNE_STALE_INTERVAL);

  startWebhookServer();

  // S13: register hook-bridge event subscribers (bodies extracted to orch/routing/hook-bridge-subscribers.ts)
  registerHookBridgeSubscribers(bus, adapter, planApprovals);

  startMemoryWatcher();
  startDispatchReconciler();

  // DR-0014: re-deliver child results that turned terminal while the server was down and
  // DR-0014 §8: wake suspended manager threads on child-task terminal events, and let the
  // dispatch path close the suspension race window without a domain→orchestration import.
  registerTaskTreeSubscribers(bus);
  jobCtx.onThreadSuspended = (threadId) => reconcileWaitingTasks(threadId);

  // resume suspended parents. Runs last — needs jobCtx.adapter and the thread system ready.
  // (markRunningAsFailedOnStartup above already failed all in-flight children, so every
  // awaited child THREAD is terminal or missing by now; child TASKS are reconciled
  // against disk and stay awaited while open.)
  recoverWaitingThreads().catch((e) => log.error(`recoverWaitingThreads failed: ${(e as Error).message}`));

  // Periodic disk-driven backstop: recover any manager left suspended on a child task that is
  // already terminal on disk but whose event/settle delivery was lost to a race (2026-06-29).
  startWaitingManagerSweep();

  log.info(`Cortex agent is running (${adapter.name}) — backend: ${getActiveBackend()}`);
})();
