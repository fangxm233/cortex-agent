import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { AUTH_HEADER, getWebhookToken, timingSafeEqualStr } from '@core/auth.js';
import * as http from 'http';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { sendCommand, isDeviceOnline, getOnlineDevices } from '@domain/remote/client-manager.js';
import { stageRemoteFile } from '@domain/remote/device-file.js';
import { createWaitpoint, cancelWaitpoint, listWaitpointsForSession, publicView } from '@domain/waitpoints/service.js';
import { ingestSignal, toSignalInput } from '../waitpoint-ingress.js';
import { waitpointRepo } from '@store/waitpoint-repo.js';
import { registerAskQuestion, registerPlanApproval } from './hook-bridge.js';
import { normalizeAskLevel } from '@platform/index.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { validateCommissionFinalize, finalizeCommission } from '@domain/commissions/commission-finalize.js';
import { enterCommissionDraft } from '@domain/commissions/commission-draft.js';
import { publishSessionCommission } from '../session-events.js';
import { getCurrentPlanFilePath } from '../../agent-adapter/claude/event-parser.js';
import { orchestrationBus } from '../runtime.js';
import { handleSubagentWebhook } from '../subagent-webhook.js';
import { handleTeamWebhook } from '../team-webhook.js';
import { handleBenchmarkSessionWebhook } from '../benchmark-session-webhook.js';
import { sendAgentFiles } from '../agent-file-send.js';
import { sendAgentView } from '../agent-view-send.js';
import { sendAgentDecisions } from '../agent-decision-send.js';

const log = createLogger('webhook');

const PORT = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
// Read at call time, not import time — dotenv.config() in app.ts runs AFTER ESM imports
function getSecret() { return process.env.GITHUB_WEBHOOK_SECRET || ''; }

function verifySignature(body, signature) {
  const secret = getSecret();
  if (!secret) { log.warn('No GITHUB_WEBHOOK_SECRET configured — skipping signature verification'); return true; }
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Bearer-token gate for every webhook route EXCEPT /webhook/github (which authenticates
 * via its own HMAC signature). Reads the call-time CORTEX_WEBHOOK_TOKEN and compares it
 * timing-safely against the `x-cortex-token` request header. Fail-closed: an unset token
 * or a missing/mismatched header is rejected.
 */
function isWebhookAuthorized(req): boolean {
  const provided = (req.headers || {})[AUTH_HEADER];
  const headerVal = Array.isArray(provided) ? provided[0] : provided;
  return timingSafeEqualStr(getWebhookToken(), headerVal);
}

/**
 * Read and parse a JSON body.
 *
 * `maxBytes` is opt-in so existing trusted callers keep their behaviour, but any route reachable
 * without the bearer token must pass one — otherwise the concatenation below is an unbounded
 * allocation driven by an unauthenticated caller. Over the cap the request is destroyed and the
 * callback fires with a `tooLarge` error.
 */
/**
 * Routes that do NOT take the shared bearer token, because each carries a narrower credential of
 * its own. Deliberately a Set of exact paths: handing `CORTEX_WEBHOOK_TOKEN` to a training script
 * would give it `remote-command` on every device, which is why the signal route authenticates with
 * a capability scoped to one waitpoint instead.
 */
const TOKEN_EXEMPT_ROUTES = new Set(['/webhook/github', '/webhook/signal']);

/** Ceiling on an unauthenticated signal body. A signal is a summary, not a log. */
const SIGNAL_BODY_MAX_BYTES = 64 * 1024;

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

// --- /hook/ask-user-question (hook-facing ask API: level + sessionId→channel resolution) ---

/** Resolve a session's bound conduit channel from the session registry, or null. */
async function resolveSessionChannel(sessionId: unknown): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const name = await sessionStore.lookupBySessionId(sessionId);
  if (!name) return null;
  const record = await sessionStore.lookupSession(name);
  return record?.channel ?? null;
}

async function handleAskUserQuestion(data: any, res: http.ServerResponse): Promise<void> {
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

function createWebhookHandler() {
  return (req, res) => {
    // A benchmark trial's server serves the one route its launcher drives and refuses the rest.
    const benchmarkOnly = process.env.CORTEX_WEBHOOK_BENCHMARK_ONLY === '1';
    if (benchmarkOnly && !(req.method === 'POST' && req.url === '/webhook/benchmark-session')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    // --- Auth gate: every route requires the webhook bearer token, except the two that carry
    //     their own credential — /webhook/github (HMAC; GitHub cannot send our header) and
    //     /webhook/signal (a per-waitpoint capability in the body, checked inside the handler).
    //     Exact string match only: a prefix test here would open every future /webhook/signal*. ---
    if (!TOKEN_EXEMPT_ROUTES.has(req.url) && !isWebhookAuthorized(req)) {
      log.warn(`webhook auth rejected: ${req.method} ${req.url}`);
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    // --- Device list query (from MCP sidecar) ---
    if (req.method === 'GET' && req.url === '/webhook/devices') {
      const devices = getOnlineDevices().map(d => d.device);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices }));
      return;
    }

    // --- Remote command proxy (from MCP sidecar → client-manager) ---
    if (req.method === 'POST' && req.url === '/webhook/remote-command') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) {
          res.writeHead(400); res.end('Bad JSON'); return;
        }
        const { device, action, params, timeout } = data;
        if (!device || !action) {
          res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'device and action required' }));
          return;
        }
        if (!isDeviceOnline(device)) {
          const online = getOnlineDevices().map(d => d.device);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Device "${device}" is not online`, onlineDevices: online }));
          return;
        }
        try {
          const result = await sendCommand(device, { action, params: params || {}, timeout });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: result }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Remote file staging (from MCP sidecar → client-manager reverse channel) ---
    // For senders that upload from a local path themselves (Slack, Feishu): stream the device's
    // file into a server-local staging area and hand back the path. The Web `send_file` does NOT
    // come through here — it passes `device` to /webhook/ui-file and the daemon streams straight
    // into the session's outputs, saving a full copy of every transfer.
    if (req.method === 'POST' && req.url === '/webhook/remote-fetch') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { device, filePath, maxBytes } = data || {};
        if (!device || !filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'device and filePath required' }));
          return;
        }
        try {
          const staged = await stageRemoteFile({ device, filePath, maxBytes });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: staged }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Agent-sent file (from the web-only cortex-web MCP `send_file` tool) ---
    // The MCP server runs as a separate subprocess with no access to the daemon's conversation
    // history or EventBus, so it proxies the file here. The daemon copies the file into the
    // session's workspace/outputs area, records it on the transcript, and publishes the live event.
    if (req.method === 'POST' && req.url === '/webhook/ui-file') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { sessionId, filePath, fileName, files, caption, device } = data || {};
        // `files` carries a group (one row, many cards); the bare filePath form answers a single meta.
        const group = Array.isArray(files) ? files : null;
        if (!sessionId || !(group?.length || filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId and filePath (or files) required' }));
          return;
        }
        try {
          const metas = await sendAgentFiles({ sessionId, files: group ?? [{ filePath, fileName }], caption, device });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: group ? metas : metas[0] }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Agent-rendered view (from the web-only cortex-web MCP `send_view` tool) ---
    // Same subprocess→daemon proxy as /webhook/ui-file. The daemon lands the HTML under the
    // session's workspace/outputs/<sid>/views/ area and records an assistant message carrying a
    // `type: 'view'` attachment; the HTML itself never enters the event or the transcript.
    if (req.method === 'POST' && req.url === '/webhook/ui-view') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { sessionId, title, html, filePath, caption, height, width } = data || {};
        if (!sessionId || !title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId and title required' }));
          return;
        }
        try {
          const meta = await sendAgentView({ sessionId, title, html, filePath, caption, height, width });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: meta }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Agent-announced decisions (from the web-only cortex-web MCP `send_decision` tool) ---
    // Same subprocess→daemon proxy as /webhook/ui-view. Decision bodies are short text, so the
    // daemon records them INLINE on one assistant transcript row (no file is landed) and
    // publishes the live event; user responses arrive later via `sessions.respondDecision`.
    if (req.method === 'POST' && req.url === '/webhook/ui-decision') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { sessionId, decisions } = data || {};
        if (!sessionId || !Array.isArray(decisions) || decisions.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId and a non-empty decisions array required' }));
          return;
        }
        try {
          const items = await sendAgentDecisions({ sessionId, decisions });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { ids: items.map(d => d.id), titles: items.map(d => d.title) } }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Subagent operation (from MCP sidecar → subagent registry) ---
    // The `agent` tool's daemon side. `start` registers a run and returns at once; a foreground
    // caller then polls `wait` in bounded hops, which doubles as its liveness signal.
    if (req.method === 'POST' && req.url === '/webhook/subagent') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = await handleSubagentWebhook(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
      return;
    }

    // --- Team operation (from the cortex-workers MCP tools → team-webhook) ---
    // Every action returns at once; worker reports and questions reach the lead as deliveries.
    if (req.method === 'POST' && req.url === '/webhook/team') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = await handleTeamWebhook(data ?? {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
      return;
    }

    // --- Benchmark session (from the benchmark launcher → benchmark-session-webhook) ---
    // `start` returns once the session exists and its task is handed over; `status` is polled.
    if (req.method === 'POST' && req.url === '/webhook/benchmark-session') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = await handleBenchmarkSessionWebhook(data ?? {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
      return;
    }

    // --- PreToolUse hook: AskUserQuestion ---
    if (req.method === 'POST' && req.url === '/hook/ask-user-question') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        await handleAskUserQuestion(data, res);
      });
      return;
    }

    // --- MCP tool: cortex_commission_start ---
    //
    // The tool runs in the bundled MCP process and cannot touch the registry, so entering the mode
    // is a loopback call like every other state change an agent makes. Idempotent: a second call
    // returns the same directory, which is what lets the [Commission] block say "call it if you
    // have not already" without worrying about which entry the session came through.
    if (req.method === 'POST' && req.url === '/hook/commission-start') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
        if (!sessionId) { reply(200, { error: 'no originating session id — commission start requires CORTEX_SESSION_ID' }); return; }
        // The kill switch has to bite HERE too: since v4 this tool is the entry point, not a
        // capability handed only to sessions the user already opted in.
        if (!getSettings().commissionEnabled) {
          reply(200, { error: 'commission mode is disabled on this server (settings.commissionEnabled)' });
          return;
        }
        try {
          const result = await enterCommissionDraft(sessionId);
          if (result.ok === false) { reply(200, { error: result.error }); return; }
          if (!result.alreadyDrafting && typeof data?.channel === 'string' && data.channel) {
            publishSessionCommission({ sessionId, channel: data.channel });
          }
          reply(200, { ok: true, dir: result.dir, draftDir: result.draftDir, alreadyDrafting: result.alreadyDrafting });
        } catch (e) {
          reply(500, { error: (e as Error).message });
        }
      });
      return;
    }

    // --- PreToolUse hook: ExitPlanMode ---
    if (req.method === 'POST' && req.url === '/hook/exit-plan-mode') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { sessionId, channel, planContent, toolInput, dryRun, commission } = data;
        if (!channel) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'channel required' }));
          return;
        }
        try {
          let resolvedPlan = typeof planContent === 'string' ? planContent : '';
          if (!resolvedPlan && sessionId) {
            const planFilePath = getCurrentPlanFilePath(sessionId);
            if (planFilePath) {
              try { resolvedPlan = readFileSync(planFilePath, 'utf8'); }
              catch (readErr) { log.warn(`failed to read plan file ${planFilePath}: ${(readErr as Error).message}`); }
            }
          }
          // Commission plan-exit (DR-0037): pre-validate BEFORE asking the human so a bad
          // name/draft dir fails fast without burning an approval; land it only on approval.
          const commissionArgs = commission && typeof commission === 'object'
            ? { sessionId, name: commission.name, title: commission.title, contractPath: commission.contractPath }
            : null;
          if (commissionArgs) {
            const check = await validateCommissionFinalize(commissionArgs);
            if (check.ok === false) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'commission-invalid', message: check.error }));
              return;
            }
          }
          const requestId = crypto.randomUUID();
          const result = await registerPlanApproval(requestId, channel, sessionId, resolvedPlan, toolInput || {}, dryRun === true);
          const approved = (result as { approved?: boolean } | undefined)?.approved === true;
          const finalized = commissionArgs && approved ? await finalizeCommission(commissionArgs) : null;
          if (finalized && finalized.ok === true) {
            orchestrationBus()?.publish({ type: 'commission.updated', commissionId: finalized.commissionId, projectId: finalized.projectId });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(finalized ? { ...result, commission: finalized } : result));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }
    // --- /webhook/signal (an external process reporting that what an agent waited for is done) ---
    //     The only unauthenticated-by-bearer-token POST. Its credential is the per-waitpoint secret
    //     in the body, so a training script can be handed a capability that resolves exactly one
    //     waitpoint and can do nothing else.
    if (req.method === 'POST' && req.url === '/webhook/signal') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) {
          if ((error as any).tooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accepted: false, error: 'signal body too large' }));
            return;
          }
          res.writeHead(400);
          res.end('Bad JSON');
          return;
        }
        try {
          const outcome = await ingestSignal(toSignalInput(data || {}, null, 'http'));
          switch (outcome.kind) {
            case 'accepted':
              res.writeHead(202, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: true, fired: outcome.fired, state: outcome.waitpoint.state }));
              return;
            case 'duplicate':
              res.writeHead(202, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: true, duplicate: true, state: outcome.waitpoint.state }));
              return;
            case 'already-resolved':
              // 410, not 404: the caller asked about something that really existed, and echoing the
              // original resolution lets a script log "already reported" instead of retrying forever.
              res.writeHead(410, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: false, state: outcome.state, resolved_at: outcome.resolvedAt }));
              return;
            case 'bad-secret':
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: false, error: 'bad secret' }));
              return;
            case 'rate-limited':
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: false, error: 'too many signals' }));
              return;
            default:
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: false, error: 'unknown waitpoint' }));
              return;
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: false, error: (e as Error).message }));
        }
      }, SIGNAL_BODY_MAX_BYTES);
      return;
    }

    // --- /webhook/waitpoint (agent-side ops behind the normal bearer token) ---
    if (req.method === 'POST' && req.url === '/webhook/waitpoint') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = (payload) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        try {
          const action = data?.action;
          if (action === 'create') {
            const channel = data.channel || await resolveSessionChannel(data.sessionId);
            if (!channel) return reply({ success: false, error: 'cannot resolve a channel for this session' });
            if (!data.label || !data.intent) return reply({ success: false, error: 'label and intent are required' });
            const { waitpoint, secret } = await createWaitpoint({
              label: String(data.label),
              intent: String(data.intent),
              owner: {
                sessionId: String(data.sessionId || ''),
                channel,
                project: data.project || null,
              },
              quorum: data.quorum,
              failFast: data.failFast,
              maxSignals: data.maxSignals,
              coalesceMs: data.coalesceMs,
              ttlMs: data.ttlMs,
              emitFrom: data.device ? { kind: 'device', device: String(data.device) } : { kind: 'local' },
            });
            return reply({ success: true, data: { ...publicView(waitpoint), secret } });
          }
          if (action === 'check') {
            if (data.id) {
              const wp = await waitpointRepo.get(String(data.id));
              if (!wp) return reply({ success: false, error: `unknown waitpoint: ${data.id}` });
              return reply({ success: true, data: publicView(wp) });
            }
            const mine = await listWaitpointsForSession(String(data.sessionId || ''));
            return reply({ success: true, data: { waitpoints: mine.map(publicView) } });
          }
          if (action === 'cancel') {
            if (!data.id) return reply({ success: false, error: 'id is required' });
            const result = await cancelWaitpoint(String(data.id));
            return reply({ success: true, data: result });
          }
          return reply({ success: false, error: `unknown action: ${action}` });
        } catch (e) {
          reply({ success: false, error: (e as Error).message });
        }
      });
      return;
    }


    if (req.method !== 'POST' || req.url !== '/webhook/github') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    readJsonBody(req, (error, body, event) => {
      const sig = req.headers['x-hub-signature-256'];
      if (!verifySignature(body, sig)) {
        log.warn('Invalid signature');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      if (error) {
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }

      const eventType = req.headers['x-github-event'];
      if (eventType !== 'push') {
        res.writeHead(200);
        res.end('Ignored');
        return;
      }

      res.writeHead(200);
      res.end('OK');
    });
  };
}

function startWebhookServer() {
  const server = http.createServer(createWebhookHandler());

  server.listen(PORT, '127.0.0.1', () => {
    log.info(`Listening on 127.0.0.1:${PORT}/webhook/github`);
  });

  return server;
}

export { startWebhookServer, createWebhookHandler };
