import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { AUTH_HEADER, getWebhookToken, timingSafeEqualStr } from '@core/auth.js';
import * as http from 'http';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { sendCommand, isDeviceOnline, getOnlineDevices } from '@domain/remote/client-manager.js';
import { stageRemoteFile } from '@domain/remote/device-file.js';
import { createWaitpoint, cancelWaitpoint, listOwnedWaitpoints } from '@domain/waitpoints/service.js';
import { agentWaitpointView, ownsWaitpoint } from '@domain/waitpoints/view.js';
import { ingestSignal, toSignalInput } from '../waitpoint-ingress.js';
import { waitpointRepo, type Waitpoint } from '@store/waitpoint-repo.js';
import { registerAskQuestion, registerPlanApproval } from './hook-bridge.js';
import { normalizeAskLevel } from '@platform/index.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getCurrentPlanFilePath } from '../../agent-adapter/claude/event-parser.js';
import { handleSubagentWebhook } from '../subagent-webhook.js';
import { handleTeamWebhook } from '../team-webhook.js';
import { handleBoardWebhook } from '../board-webhook.js';
import { handleBenchmarkSessionWebhook } from '../benchmark-session-webhook.js';
import { sendAgentFiles } from '../agent-file-send.js';
import { sendAgentView } from '../agent-view-send.js';
import { sendAgentDecisions } from '../agent-decision-send.js';

const log = createLogger('webhook');

const PORT = parseInt(process.env.WEBHOOK_PORT || '3001', 10);

type Res = http.ServerResponse;
type RequestHandler = (req: http.IncomingMessage, res: Res) => void;
type JsonHandler = (data: any, res: Res) => unknown;

/**
 * Bearer-token gate for every webhook route except /webhook/signal. Reads the call-time
 * CORTEX_WEBHOOK_TOKEN and compares it timing-safely against the `x-cortex-token` request header.
 * Fail-closed: an unset token or a missing/mismatched header is rejected.
 */
function isWebhookAuthorized(req): boolean {
  const provided = (req.headers || {})[AUTH_HEADER];
  const headerVal = Array.isArray(provided) ? provided[0] : provided;
  return timingSafeEqualStr(getWebhookToken(), headerVal);
}

/**
 * Routes that do NOT take the shared bearer token, because each carries a narrower credential of
 * its own. Deliberately a Set of exact paths: handing `CORTEX_WEBHOOK_TOKEN` to a training script
 * would give it `remote-command` on every device, which is why the signal route authenticates with
 * a capability scoped to one waitpoint instead.
 */
const TOKEN_EXEMPT_ROUTES = new Set(['/webhook/signal']);

/** Ceiling on an unauthenticated signal body. A signal is a summary, not a log. */
const SIGNAL_BODY_MAX_BYTES = 64 * 1024;

/**
 * Read and parse a JSON body.
 *
 * `maxBytes` is opt-in, but any route reachable without the bearer token must pass one — otherwise
 * the concatenation below is an unbounded allocation driven by an unauthenticated caller. Over the
 * cap the request is destroyed and the callback fires with a `tooLarge` error.
 */
function readJsonBody(req, callback, maxBytes = 0) {
  let body = '';
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (maxBytes > 0 && size > maxBytes) {
      aborted = true;
      const error: any = new Error(`body exceeds ${maxBytes} bytes`);
      error.tooLarge = true;
      req.destroy();
      callback(error);
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      callback(null, body, JSON.parse(body));
    } catch (error) {
      callback(error);
    }
  });
}

function sendJson(res: Res, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** A POST route with a JSON body: unparseable bodies get 400, a handler that throws gets 500. */
function jsonRoute(handler: JsonHandler): RequestHandler {
  return (req, res) => readJsonBody(req, async (error, _body, data) => {
    if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
    try {
      await handler(data, res);
    } catch (e) {
      log.error(`${req.url} failed: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
    }
  });
}

/** A JSON route whose handler's return value is the 200 reply. */
function replyRoute(handler: (data: any) => unknown): RequestHandler {
  return jsonRoute(async (data, res) => sendJson(res, 200, await handler(data ?? {})));
}

/** Run a device/agent operation and reply `{success, data}`, or `{success: false, error}` with 200. */
async function replySuccess(res: Res, run: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, { success: true, data: await run() });
  } catch (e) {
    sendJson(res, 200, { success: false, error: (e as Error).message });
  }
}

/** Resolve a session's bound conduit channel from the session registry, or null. */
async function resolveSessionChannel(sessionId: unknown): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const record = await sessionStore.getById(sessionId);
  return record?.channel ?? null;
}

// --- Remote device proxies (from the MCP sidecar → client-manager) ---

async function handleRemoteCommand(data: any, res: Res): Promise<void> {
  const { device, action, params, timeout } = data;
  if (!device || !action) {
    res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'device and action required' }));
    return;
  }
  if (!isDeviceOnline(device)) {
    const online = getOnlineDevices().map(d => d.device);
    sendJson(res, 200, { success: false, error: `Device "${device}" is not online`, onlineDevices: online });
    return;
  }
  await replySuccess(res, () => sendCommand(device, { action, params: params || {}, timeout }));
}

// For senders that upload from a local path themselves (Slack, Feishu): stream the device's file
// into a server-local staging area and hand back the path. The Web `send_file` does NOT come
// through here — it passes `device` to /webhook/ui-file and the daemon streams straight into the
// session's outputs, saving a full copy of every transfer.
async function handleRemoteFetch(data: any, res: Res): Promise<void> {
  const { device, filePath, maxBytes } = data || {};
  if (!device || !filePath) {
    sendJson(res, 400, { success: false, error: 'device and filePath required' });
    return;
  }
  await replySuccess(res, () => stageRemoteFile({ device, filePath, maxBytes }));
}

// --- Web-only cortex-web MCP tools (send_file / send_view / send_decision) ---
// The MCP server runs as a separate subprocess with no access to the daemon's conversation history
// or EventBus, so it proxies here. The daemon lands files/views under the session's
// workspace/outputs area, records the transcript row, and publishes the live event.

async function handleUiFile(data: any, res: Res): Promise<void> {
  const { sessionId, filePath, fileName, files, caption, device } = data || {};
  // `files` carries a group (one row, many cards); the bare filePath form answers a single meta.
  const group = Array.isArray(files) ? files : null;
  if (!sessionId || !(group?.length || filePath)) {
    sendJson(res, 400, { success: false, error: 'sessionId and filePath (or files) required' });
    return;
  }
  await replySuccess(res, async () => {
    const metas = await sendAgentFiles({ sessionId, files: group ?? [{ filePath, fileName }], caption, device });
    return group ? metas : metas[0];
  });
}

// The HTML itself never enters the event or the transcript: the row carries a `type: 'view'`
// attachment pointing at outputs/<sid>/views/.
async function handleUiView(data: any, res: Res): Promise<void> {
  const { sessionId, title, html, filePath, caption, height, width } = data || {};
  if (!sessionId || !title) {
    sendJson(res, 400, { success: false, error: 'sessionId and title required' });
    return;
  }
  await replySuccess(res, () => sendAgentView({ sessionId, title, html, filePath, caption, height, width }));
}

// Decision bodies are short text, recorded INLINE on one assistant row; user responses arrive later
// via `sessions.respondDecision`.
async function handleUiDecision(data: any, res: Res): Promise<void> {
  const { sessionId, decisions } = data || {};
  if (!sessionId || !Array.isArray(decisions) || decisions.length === 0) {
    sendJson(res, 400, { success: false, error: 'sessionId and a non-empty decisions array required' });
    return;
  }
  await replySuccess(res, async () => {
    const items = await sendAgentDecisions({ sessionId, decisions });
    return { ids: items.map(d => d.id), titles: items.map(d => d.title) };
  });
}

// --- /hook/ask-user-question (hook-facing ask API: level + sessionId→channel resolution) ---

async function handleAskUserQuestion(data: any, res: Res): Promise<void> {
  const { sessionId, questions, dryRun } = data;
  // Opt-in only: every caller that omits `blocking` (native hooks, TUI, PI) keeps waiting.
  const blocking = data.blocking !== false;
  const level = data.level === undefined ? null : normalizeAskLevel(data.level);
  if (data.level !== undefined && !level) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: `invalid level '${data.level}' (valid: info, warn, warning, error)` }));
    return;
  }
  const channel = data.channel || await resolveSessionChannel(sessionId);
  if (!channel || !questions?.length) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'channel and questions required (channel may be resolved from a registered sessionId)' }));
    return;
  }
  try {
    const requestId = crypto.randomUUID();
    const result = await registerAskQuestion(requestId, channel, sessionId, questions, dryRun === true, level, blocking);
    sendJson(res, 200, result);
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

// --- PreToolUse hook: ExitPlanMode ---

function resolvePlanContent(sessionId: unknown, planContent: unknown): string {
  if (typeof planContent === 'string' && planContent) return planContent;
  if (typeof sessionId !== 'string' || !sessionId) return '';
  const planFilePath = getCurrentPlanFilePath(sessionId);
  if (!planFilePath) return '';
  try {
    return readFileSync(planFilePath, 'utf8');
  } catch (readErr) {
    log.warn(`failed to read plan file ${planFilePath}: ${(readErr as Error).message}`);
    return '';
  }
}

async function approvePlan(data: any, res: Res): Promise<void> {
  const { sessionId, channel, planContent, toolInput, dryRun } = data;
  const resolvedPlan = resolvePlanContent(sessionId, planContent);
  const result = await registerPlanApproval(crypto.randomUUID(), channel, sessionId, resolvedPlan, toolInput || {}, dryRun === true);
  sendJson(res, 200, result);
}

async function handleExitPlanMode(data: any, res: Res): Promise<void> {
  if (!data.channel) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'channel required' }));
    return;
  }
  try {
    await approvePlan(data, res);
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

// --- /webhook/signal (an external process reporting that what an agent waited for is done) ---
// The only POST without the bearer token. Its credential is the per-waitpoint secret in the body,
// so a training script can be handed a capability that resolves exactly one waitpoint and can do
// nothing else.

type SignalOutcome = Awaited<ReturnType<typeof ingestSignal>>;

const SIGNAL_REPLIES: Record<string, (outcome: any) => [number, unknown]> = {
  accepted: (o) => [202, { accepted: true, fired: o.fired, state: o.waitpoint.state, ...(o.held ? { held: true } : {}) }],
  duplicate: (o) => [202, { accepted: true, duplicate: true, state: o.waitpoint.state }],
  // 410, not 404: the caller asked about something that really existed, and echoing the original
  // resolution lets a script log "already reported" instead of retrying forever.
  'already-resolved': (o) => [410, { accepted: false, state: o.state, resolved_at: o.resolvedAt }],
  'bad-secret': () => [401, { accepted: false, error: 'bad secret' }],
  'unknown-member': (o) => [422, { accepted: false, error: unknownMemberError(o) }],
  'rate-limited': () => [429, { accepted: false, error: 'too many signals' }],
};

export function unknownMemberError(o: { member: string | null; members: string[] }): string {
  const expected = `this waitpoint expects one of: ${o.members.join(', ')}`;
  return o.member ? `unknown member "${o.member}" — ${expected}` : `no member named — ${expected}`;
}

function signalReply(outcome: SignalOutcome): [number, unknown] {
  const build = SIGNAL_REPLIES[outcome.kind];
  return build ? build(outcome) : [404, { accepted: false, error: 'unknown waitpoint' }];
}

const handleSignal: RequestHandler = (req, res) => readJsonBody(req, async (error, _body, data) => {
  if (error?.tooLarge) { sendJson(res, 413, { accepted: false, error: 'signal body too large' }); return; }
  if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
  try {
    const [status, payload] = signalReply(await ingestSignal(toSignalInput(data || {}, null, 'http')));
    sendJson(res, status, payload);
  } catch (e) {
    sendJson(res, 500, { accepted: false, error: (e as Error).message });
  }
}, SIGNAL_BODY_MAX_BYTES);

// --- /webhook/waitpoint (agent-side ops behind the normal bearer token) ---

function waitpointView(wp: Waitpoint): Record<string, unknown> {
  return agentWaitpointView(wp, Date.now(), getSettings().waitpointMaxWakesPerHour);
}

/** The session asking, resolved the way `create` resolves the owner it records. */
async function waitpointCaller(data: any): Promise<{ sessionId: string; channel: string | null }> {
  const sessionId = String(data.sessionId || '');
  return { sessionId, channel: data.channel || await resolveSessionChannel(sessionId) };
}

async function createWaitpointOp(data: any): Promise<unknown> {
  const channel = data.channel || await resolveSessionChannel(data.sessionId);
  if (!channel) return { success: false, error: 'cannot resolve a channel for this session' };
  if (!data.label || !data.intent) return { success: false, error: 'label and intent are required' };
  const { waitpoint, secret } = await createWaitpoint({
    label: String(data.label),
    intent: String(data.intent),
    owner: { sessionId: String(data.sessionId || ''), channel, project: data.project || null },
    quorum: data.quorum,
    failFast: data.failFast,
    maxSignals: data.maxSignals,
    coalesceMs: data.coalesceMs,
    ttlMs: data.ttlMs,
    emitFrom: data.device ? { kind: 'device', device: String(data.device) } : { kind: 'local' },
  });
  return { success: true, data: { ...waitpointView(waitpoint), secret } };
}

/** A waitpoint by id, but only one this session armed or will be woken by — the rule the UI uses. */
async function ownedWaitpoint(data: any): Promise<{ wp: Waitpoint } | { error: string }> {
  const id = String(data.id);
  const wp = await waitpointRepo.get(id);
  if (!wp) return { error: `unknown waitpoint: ${id}` };
  const caller = await waitpointCaller(data);
  if (!ownsWaitpoint(wp, caller.sessionId, caller.channel)) return { error: `waitpoint ${id} belongs to another session` };
  return { wp };
}

async function checkWaitpointOp(data: any): Promise<unknown> {
  if (data.id) {
    const found = await ownedWaitpoint(data);
    if ('error' in found) return { success: false, error: found.error };
    return { success: true, data: waitpointView(found.wp) };
  }
  const caller = await waitpointCaller(data);
  const mine = await listOwnedWaitpoints(caller.sessionId, caller.channel);
  return { success: true, data: { waitpoints: mine.map(waitpointView) } };
}

async function cancelWaitpointOp(data: any): Promise<unknown> {
  if (!data.id) return { success: false, error: 'id is required' };
  const found = await ownedWaitpoint(data);
  if ('error' in found) return { success: false, error: found.error };
  return { success: true, data: await cancelWaitpoint(found.wp.id) };
}

const WAITPOINT_OPS: Record<string, (data: any) => Promise<unknown>> = {
  create: createWaitpointOp,
  check: checkWaitpointOp,
  cancel: cancelWaitpointOp,
};

async function handleWaitpointOp(data: any): Promise<unknown> {
  const op = Object.hasOwn(WAITPOINT_OPS, data?.action) ? WAITPOINT_OPS[data.action] : null;
  if (!op) return { success: false, error: `unknown action: ${data?.action}` };
  try {
    return await op(data);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// --- Route table ---

const POST_ROUTES: Record<string, RequestHandler> = {
  '/webhook/remote-command': jsonRoute(handleRemoteCommand),
  '/webhook/remote-fetch': jsonRoute(handleRemoteFetch),
  '/webhook/ui-file': jsonRoute(handleUiFile),
  '/webhook/ui-view': jsonRoute(handleUiView),
  '/webhook/ui-decision': jsonRoute(handleUiDecision),
  // The `agent` tool's daemon side. `start` registers a run and returns at once; a foreground
  // caller then polls `wait` in bounded hops, which doubles as its liveness signal.
  '/webhook/subagent': replyRoute(handleSubagentWebhook),
  // Every team action returns at once; worker reports and questions reach the lead as deliveries.
  '/webhook/team': replyRoute(handleTeamWebhook),
  // board_open and cortex_context's board field. Never touches board.html after the scaffold.
  '/webhook/board': replyRoute((data) => handleBoardWebhook(data)),
  // Benchmark launcher: `start` returns once the session exists and its task is handed over;
  // `status` is polled.
  '/webhook/benchmark-session': replyRoute(handleBenchmarkSessionWebhook),
  '/webhook/signal': handleSignal,
  '/webhook/waitpoint': replyRoute(handleWaitpointOp),
  '/hook/ask-user-question': jsonRoute(handleAskUserQuestion),
  '/hook/exit-plan-mode': jsonRoute(handleExitPlanMode),
};

const GET_ROUTES: Record<string, RequestHandler> = {
  '/webhook/devices': (_req, res) => sendJson(res, 200, { devices: getOnlineDevices().map(d => d.device) }),
};

const ROUTES_BY_METHOD: Record<string, Record<string, RequestHandler>> = { GET: GET_ROUTES, POST: POST_ROUTES };

function findRoute(method: string | undefined, url: string | undefined): RequestHandler | null {
  const routes = ROUTES_BY_METHOD[method ?? ''];
  return routes && url && Object.hasOwn(routes, url) ? routes[url] : null;
}

function createWebhookHandler(): RequestHandler {
  return (req, res) => {
    // A benchmark trial's server serves the one route its launcher drives and refuses the rest.
    const benchmarkOnly = process.env.CORTEX_WEBHOOK_BENCHMARK_ONLY === '1';
    if (benchmarkOnly && !(req.method === 'POST' && req.url === '/webhook/benchmark-session')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    // Every route requires the bearer token except /webhook/signal, whose credential is a
    // per-waitpoint capability checked inside the handler. Exact match only: a prefix test here
    // would open every future /webhook/signal*.
    if (!TOKEN_EXEMPT_ROUTES.has(req.url ?? '') && !isWebhookAuthorized(req)) {
      log.warn(`webhook auth rejected: ${req.method} ${req.url}`);
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    const route = findRoute(req.method, req.url);
    if (!route) { res.writeHead(404); res.end('Not found'); return; }
    route(req, res);
  };
}

function startWebhookServer() {
  const server = http.createServer(createWebhookHandler());

  server.listen(PORT, '127.0.0.1', () => {
    log.info(`Listening on 127.0.0.1:${PORT}`);
  });

  return server;
}

export { startWebhookServer, createWebhookHandler };
