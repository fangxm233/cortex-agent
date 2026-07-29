// input:  MCP sidecars, GitHub push, remote commands, hook events
// output: startWebhookServer
// pos:    GitHub/task-op/thread-op/manager-qa/hook webhook HTTP entry point
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createLogger } from '@core/log.js';
import { AUTH_HEADER, getWebhookToken, timingSafeEqualStr } from '@core/auth.js';
import * as http from 'http';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { taskMutator } from '@domain/tasks/mutator.js';
import { sendCommand, isDeviceOnline, getOnlineDevices } from '@domain/remote/client-manager.js';
import { registerDispatchExecution } from '@domain/executions/registry.js';
import { registerAskQuestion, registerPlanApproval } from './hook-bridge.js';
import { getCurrentPlanFilePath } from '@domain/agents/index.js';
import { ctx as jobCtx } from '@domain/scheduling/job-registry.js';
import { createThread, cancelThread, readArtifact, listTemplates, listAgents, checkSpawnGuards, getRootThreadId, registerChildSpawn, buildThreadTree, getTreeThreads, buildContractPrompt, buildMissionChain, isArtifactUnchangedSinceStepStart } from '@domain/threads/index.js';
import { runThreadDetached } from '../thread-executor.js';
import { buildThreadSummary } from '@domain/threads/runner.js';
import { Icons } from '@core/icons.js';
import { buildStatusActionBlocks, buildSealedStatusActionBlocks, initStatusBlocks } from '../status-helpers.js';
import { threadStore } from '@store/thread-repo.js';
import { fireThreadCallback } from '../thread-callback.js';
import { askManager, getAnswer, submitAnswer } from '../manager-qa.js';
import { sendAgentFile } from '../agent-file-send.js';
import type { Destination, MessageRef } from '@platform/index.js';
import type { RunThreadOptions } from '@core/types/thread-types.js';

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
 * B2-C: a task-linked `cortex-run --name X` writes `<DATA_DIR>/tmp/cortex-run/X/output.log` on the
 * target device but, being a separate CLI process, cannot register an execution into the daemon's
 * in-memory registry. This is the daemon-side seam: on a successful launch, register (idempotent,
 * keyed by taskId) a `dispatch` execution carrying `runName` + `machine` so the Web UI can resolve
 * the run's live log by executionId (subscribeExecutionLog → resolveExecutionLogLocation). Requires
 * a taskId (the record key); a run without `--task-id` is not tailable through the UI. Best-effort —
 * never blocks or fails the launch response.
 */
function maybeRegisterCortexRunExecution(action: string, params: any, device: string): void {
  if (action !== 'cortex-run.launch') return;
  const name = params?.name;
  const taskId = params?.taskId;
  const taskProject = params?.taskProject;
  if (!name || !taskId) return;
  try {
    registerDispatchExecution({
      taskId,
      machine: device,
      project: taskProject || undefined,
      runName: name,
    });
    log.info(`B2-C: registered dispatch execution for cortex-run "${name}" (task ${taskId} on ${device})`);
  } catch (e) {
    log.warn(`B2-C: failed to register cortex-run execution for "${name}": ${(e as Error).message}`);
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

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      callback(null, body, JSON.parse(body));
    } catch (error) {
      callback(error);
    }
  });
}

// --- Task operation handler (routes remote task mutations through TaskStore) ---

const TASK_OP_HANDLERS = {
  complete: (data) => taskMutator.complete(data.task_id, data.note || ''),
  block: (data) => taskMutator.block(data.task_id, data.reason || 'blocked by remote agent'),
  unblock: (data) => taskMutator.unblock(data.task_id),
  add: (data) => taskMutator.add(data.project, data.text, data.why || '', data.done_when || '', data.priority, data.template, data.depends_on),
  claim: (data) => taskMutator.claim(data.task_id, data.agent || 'remote'),
  unclaim: (data) => taskMutator.unclaim(data.task_id),
  uncomplete: (data) => taskMutator.uncomplete(data.task_id),
  pause: (data) => taskMutator.pause(data.task_id),
  resume: (data) => taskMutator.resume(data.task_id),
};

function createWebhookHandler(_options: {
  // `secret` (GitHub HMAC) is read at call time via getSecret(); kept in the type for
  // backward-compatible option passing from startWebhookServer.
  secret?: string;
} = {}) {
  return (req, res) => {
    // --- Auth gate: every route requires the webhook bearer token, except /webhook/github
    //     which authenticates via its own HMAC signature (GitHub cannot send our header). ---
    if (req.url !== '/webhook/github' && !isWebhookAuthorized(req)) {
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
          maybeRegisterCortexRunExecution(action, params, device);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: result }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Remote task operation (from MCP sidecar on branch bases) ---
    if (req.method === 'POST' && req.url === '/webhook/task-op') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) {
          res.writeHead(400); res.end('Bad JSON'); return;
        }
        // Auth handled by the global token gate above (was: body-secret check).
        const handler = TASK_OP_HANDLERS[data.op];
        if (!handler) {
          res.writeHead(400); res.end(JSON.stringify({ success: false, message: `Unknown op: ${data.op}` }));
          return;
        }

        try {
          const result = await handler(data);
          log.info(`task-op ${data.op} ${data.task_id || data.project}: ${result.message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          log.error(`task-op error: ${e.message}`);
          res.writeHead(500); res.end(JSON.stringify({ success: false, message: e.message }));
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
        const { sessionId, filePath, fileName, caption } = data || {};
        if (!sessionId || !filePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'sessionId and filePath required' }));
          return;
        }
        try {
          const meta = await sendAgentFile({ sessionId, filePath, fileName, caption });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: meta }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: (e as Error).message }));
        }
      });
      return;
    }

    // --- Thread operation (from MCP sidecar → thread system) ---
    // Local-only, no secret (same trust model as /webhook/remote-command). thread_start is
    // fire-and-forget: createThread + runThread().catch() without await, returning the threadId.
    if (req.method === 'POST' && req.url === '/webhook/thread-op') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = (obj: any) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        try {
          const action = data.action;
          if (action === 'start') {
            const { template, agent, message } = data;
            if ((template && agent) || (!template && !agent)) {
              return reply({ success: false, error: 'provide exactly one of template or agent' });
            }
            if (!message) return reply({ success: false, error: 'message required' });
            const maxDepth = parseInt(process.env.CORTEX_THREAD_MAX_DEPTH || '5', 10) || 5;
            const curDepth = Number(data.depth) || 0;
            if (curDepth >= maxDepth) {
              return reply({ success: false, error: `max thread depth (${maxDepth}) reached — cannot spawn nested thread at depth ${curDepth}` });
            }
            if (!jobCtx.adapter) {
              return reply({ success: false, error: 'no platform adapter available (daemon not fully initialized)' });
            }
            // Tree resource guards (DR-0014): width / node count / budget. A rejection is a
            // signal to escalate or re-plan — the error text says so to the calling agent.
            const parentThread = data.parentThreadId ? threadStore.get(String(data.parentThreadId)) : null;
            const guard = checkSpawnGuards(parentThread);
            if (guard.ok === false) {
              return reply({ success: false, error: `${guard.reason}. Do NOT retry this spawn — fold the remaining work into your own step, or escalate by calling the thread_abort tool with a diagnosis.` });
            }
            const projectId = data.projectId || 'general';
            // The originating conduit (the starter agent's SLACK_CHANNEL, forwarded by thread-ops.ts).
            // When present we route output back to that channel with a live status message, mirroring
            // the Slack `!thread` path (thread-executor handleThreadStart). When absent (non-Slack /
            // channel-less context) we fall back to project-report routing (project conduit → admin DM).
            const haveChannel = typeof data.channel === 'string' && data.channel.length > 0;
            const channel = data.channel || projectId;
            // Structured delegation contract (DR-0014): optional thread_start params compose
            // into a contract prompt; the ancestor goal chain rides along to prevent drift.
            const contract = (data.goal || data.done_when || data.context_files || data.deliverable_path || data.budget_usd != null)
              ? {
                  goal: String(data.goal || message).slice(0, 500),
                  doneWhen: data.done_when ? String(data.done_when) : null,
                  contextFiles: Array.isArray(data.context_files) ? data.context_files.map(String) : undefined,
                  deliverablePath: data.deliverable_path ? String(data.deliverable_path) : null,
                  budgetUsd: data.budget_usd != null ? Number(data.budget_usd) : null,
                }
              : null;
            const missionChain = buildMissionChain(parentThread);
            const thread = createThread(channel, {
              templateName: template || null,
              agentName: agent || null,
              userMessage: buildContractPrompt({ message, contract, missionChain }),
              userMessageTs: `mcp_${Date.now()}`,
              projectId,
              metadata: {
                trigger: 'mcp-thread',
                depth: curDepth + 1,
                parentSessionId: data.parentSessionId || null,
                parentThreadId: data.parentThreadId || null,
                parentChannel: data.parentChannel || null,
                parentProfile: data.parentProfile || null,
                rootThreadId: parentThread ? getRootThreadId(parentThread) : null,
                resumeDest: haveChannel ? 'interactive-reply' : 'project-report',
                contract,
                missionChain,
              },
            });
            // Register the child on its thread parent: childThreadIds always (width counter),
            // waitingOn when the parent intends to suspend on it (wait defaults to true for
            // thread parents — the [WAIT_CHILDREN] protocol).
            if (parentThread) {
              await registerChildSpawn(parentThread.id, thread.id, data.wait !== false);
            }

            let dest: Destination;
            let statusMsg: MessageRef | null = null;
            if (haveChannel) {
              dest = { type: 'interactive-reply', conduit: channel, sessionId: '' };
              const label = template || agent;
              const startText = `${Icons.processing} Starting thread (${template ? label : `agent:${label}`})...`;
              try {
                statusMsg = await jobCtx.adapter.postMessage(dest, { text: startText });
                const blocksTemplate = { channel, sessionName: null, isDm: false, threadId: thread.id };
                await jobCtx.adapter.updateMessage(statusMsg, {
                  text: startText,
                  richBlocks: buildStatusActionBlocks(startText, blocksTemplate),
                }).catch(() => {});
                initStatusBlocks(statusMsg, blocksTemplate);
              } catch (e) {
                log.warn(`thread-op start: status message post failed: ${(e as Error).message}`);
                statusMsg = null;
              }
            } else {
              dest = { type: 'project-report', projectId, trigger: 'mcp-thread', sessionId: '' };
            }

            const runOpts: RunThreadOptions = {
              adapter: jobCtx.adapter,
              channel,
              destination: dest,
              threadAnchorId: statusMsg ? statusMsg.messageId : null,
              statusMsg,
              startTime: Date.now(),
              onProgress: null,
              onToolUse: null,
            };
            // Hold the daemon busy gate for the WHOLE pipeline so a deferred rebuild/restart can't
            // SIGTERM app.ts mid-thread and stamp it "Interrupted by server restart". (Bare runThread
            // here was invisible to the busy/idle gate — see runThreadDetached.)
            runThreadDetached(thread.id, runOpts, {
              onSettled: (id) => {
                // Seal the live status message with a summary (interactive path only).
                // A suspended parent ([WAIT_CHILDREN] → status 'waiting') is NOT sealed:
                // it will resume; the message just reflects the suspension.
                if (statusMsg) {
                  const t = threadStore.get(id);
                  if (t && t.status === 'waiting') {
                    const n = (t.metadata?.waitingOn?.length ?? 0) + (t.metadata?.waitingOnTasks?.length ?? 0);
                    // Persist the ref so the post-resume settle can refresh this message.
                    void threadStore.mutate(t.id, (r) => { (r.metadata ??= {}).statusMsgRef = statusMsg; }).catch(() => {});
                    void jobCtx.adapter!.updateMessage(statusMsg, {
                      text: `${Icons.processing} Thread suspended — waiting on ${n} child(ren)`,
                    }).catch(() => {});
                  } else if (t) {
                    const totalNumTurns = t.steps.reduce((s, st) => s + (st.numTurns || 0), 0);
                    const summaryText = buildThreadSummary({ thread: t, totalCostUsd: t.totalCostUsd, totalNumTurns, finalOutput: null, lastAgentResult: null, executionId: null });
                    void jobCtx.adapter!.updateMessage(statusMsg, {
                      text: summaryText,
                      richBlocks: buildSealedStatusActionBlocks(summaryText, { channel, sessionName: null, isDm: false, threadId: t.id }),
                    }).catch(() => {});
                  }
                }
                // Return the promise so runThreadDetached holds the busy gate across this callback —
                // it wakes the parent agent for a full turn, and a deferred restart firing mid-wake
                // would drop the notification. The .catch keeps the returned promise non-rejecting.
                return fireThreadCallback(id).catch((e) => log.error(`thread-callback ${id}: ${(e as Error).message}`));
              },
            });
            log.info(`thread-op start ${thread.id} (${template || agent}, depth ${curDepth + 1})`);
            return reply({ success: true, data: { threadId: thread.id, status: 'running' } });
          }
          if (action === 'status') {
            const t = threadStore.get(data.threadId);
            if (!t) return reply({ success: false, error: 'thread not found' });
            return reply({ success: true, data: {
              threadId: t.id, status: t.status, activeAgent: t.activeAgent, stepCount: t.steps.length,
              totalCostUsd: t.totalCostUsd, abortReason: t.abortReason, artifactPath: t.artifactPath,
              createdAt: t.createdAt, updatedAt: t.updatedAt, endedAt: t.endedAt, error: t.error,
            } });
          }
          if (action === 'result') {
            const t = threadStore.get(data.threadId);
            if (!t) return reply({ success: false, error: 'thread not found' });
            const terminal = ['completed', 'failed', 'cancelled', 'aborted'].includes(t.status);
            const artifact = readArtifact(t.id);
            const finalOutput = t.steps.length ? t.steps[t.steps.length - 1].output : null;
            return reply({ success: true, data: {
              threadId: t.id, status: t.status, terminal,
              ...(terminal ? {} : { note: 'thread still running — result is partial' }),
              artifact, finalOutput,
            } });
          }
          if (action === 'list') {
            return reply({ success: true, data: {
              templates: listTemplates().map((t) => ({ name: t.name, description: t.description })),
              agents: listAgents().map((a) => ({ name: a.name, description: a.description })),
            } });
          }
          if (action === 'list-threads') {
            const scope = data.scope || 'mine';
            let threads = threadStore.getAll();
            if (scope === 'project') {
              const pid = data.projectId || 'general';
              threads = threads.filter((t) => t.projectId === pid);
            } else {
              // 'mine': threads spawned from the caller's session
              const sid = data.parentSessionId || null;
              threads = sid ? threads.filter((t) => t.metadata?.parentSessionId === sid) : [];
            }
            // Tree view (DR-0014): expand the matched threads to their full trees and
            // return nested nodes with per-root rollups (nodeCount/cost/byStatus/maxDepth).
            if (data.view === 'tree') {
              const rootIds = new Set(threads.map((t) => getRootThreadId(t)));
              const treeThreads = [...rootIds].flatMap((rid) => getTreeThreads(rid));
              const trees = buildThreadTree(treeThreads);
              return reply({ success: true, data: { scope, view: 'tree', count: trees.length, trees } });
            }
            threads = threads.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            const limit = Number(data.limit) || 50;
            const out = threads.slice(0, limit).map((t) => ({
              threadId: t.id, status: t.status, templateName: t.templateName, activeAgent: t.activeAgent,
              stepCount: t.steps.length, totalCostUsd: t.totalCostUsd,
              createdAt: t.createdAt, updatedAt: t.updatedAt,
              trigger: t.metadata?.trigger ?? null, depth: t.metadata?.depth ?? null,
            }));
            return reply({ success: true, data: { scope, count: out.length, threads: out } });
          }
          if (action === 'control') {
            // DR-0015 problem 1: out-of-band control plane. The agent's own thread_abort /
            // thread_split / thread_wait tool POSTs { threadId, control:{ action, ... } } here.
            // Validate the thread exists and is not terminal; reject a second concurrent control;
            // then persist metadata.pendingControl for the runner to read at the step boundary.
            const threadId = data.threadId;
            const control = data.control;
            if (!threadId || !control || typeof control.action !== 'string') {
              return reply({ success: false, error: 'control requires threadId and control.action' });
            }
            if (!['abort', 'split', 'wait'].includes(control.action)) {
              return reply({ success: false, error: `unknown control action: ${control.action}` });
            }
            const t = threadStore.get(threadId);
            if (!t) return reply({ success: false, error: 'thread not found' });
            if (['completed', 'failed', 'cancelled', 'aborted'].includes(t.status)) {
              return reply({ success: false, error: `thread is ${t.status} (terminal) — cannot accept control` });
            }
            if (t.metadata?.pendingControl) {
              return reply({ success: false, error: `thread already has a pending ${t.metadata.pendingControl.action} control — only one control intent at a time` });
            }
            // DR-0017 W2 checkpoint gate: suspension requires a fresh checkpoint. Reject wait
            // while the artifact still matches its step-start baseline; abort/split are exempt
            // (escalation must never be blocked). Fails open when no baseline is recorded.
            if (control.action === 'wait' && isArtifactUnchangedSinceStepStart(threadId)) {
              return reply({ success: false, error: 'checkpoint gate (DR-0017): your artifact has not been updated during this step. Before suspending, write your checkpoint into the artifact — current delegations & their acceptance criteria, decisions made, remaining plan, assumptions — then call thread_wait again.' });
            }
            const requestedAtStep = t.currentStepIndex;
            await threadStore.mutate(threadId, (r) => {
              (r.metadata ??= {}).pendingControl = {
                action: control.action,
                kind: control.kind ?? null,
                diagnosis: control.diagnosis ?? null,
                subtasks: Array.isArray(control.subtasks) ? control.subtasks : null,
                onTasks: Array.isArray(control.on_tasks) ? control.on_tasks : null,
                onThreads: Array.isArray(control.on_threads) ? control.on_threads : null,
                requestedAtStep,
              };
            });
            log.info(`thread-op control ${threadId}: ${control.action}${control.kind ? ` (${control.kind})` : ''}`);
            return reply({ success: true, data: { threadId, action: control.action, requestedAtStep, accepted: true } });
          }
          if (action === 'cancel') {
            const cancelled = await cancelThread(data.threadId);
            return reply({ success: true, data: { cancelled } });
          }
          return reply({ success: false, error: `unknown action: ${action}` });
        } catch (e) {
          log.error(`thread-op error: ${(e as Error).message}`);
          reply({ success: false, error: (e as Error).message });
        }
      });
      return;
    }

    // --- Manager Q&A (up-ask channel, from thread and manager-Q&A MCP sidecars) ---
    // ask:   a subtask registers a clarifying question → routed to its manager (woken) or a human.
    // poll:  the ask_manager tool polls this until the answer is present (synchronous block).
    // answer: the manager's answer_subtask tool (or a human reply) records the answer.
    if (req.method === 'POST' && req.url === '/webhook/manager-qa') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const reply = (obj: any) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        try {
          const action = data.action;
          if (action === 'ask') {
            if (!data.threadId || !data.question) {
              return reply({ success: false, error: 'ask requires threadId and question' });
            }
            const result = await askManager(String(data.threadId), String(data.question));
            if (result.ok === false) return reply({ success: false, error: result.error });
            const { ok: _ok, ...payload } = result;
            return reply({ success: true, data: payload });
          }
          if (action === 'poll') {
            if (!data.questionId) return reply({ success: false, error: 'poll requires questionId' });
            const r = getAnswer(String(data.questionId));
            return reply({ success: true, data: { answered: r.answered, answer: r.answer } });
          }
          if (action === 'answer') {
            const questionId = data.question_id ?? data.questionId;
            if (!questionId) return reply({ success: false, error: 'answer requires question_id' });
            const r = await submitAnswer(String(questionId), String(data.answer ?? ''));
            if (!r.ok) return reply({ success: false, error: r.error });
            return reply({ success: true, data: { answered: true } });
          }
          return reply({ success: false, error: `unknown action: ${action}` });
        } catch (e) {
          log.error(`manager-qa error: ${(e as Error).message}`);
          reply({ success: false, error: (e as Error).message });
        }
      });
      return;
    }

    // --- PreToolUse hook: AskUserQuestion ---
    if (req.method === 'POST' && req.url === '/hook/ask-user-question') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { sessionId, channel, questions, dryRun, threadId } = data;
        if (!channel || !questions?.length) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'channel and questions required' }));
          return;
        }
        try {
          const requestId = crypto.randomUUID();
          const result = await registerAskQuestion(requestId, channel, sessionId, questions, dryRun === true, threadId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    // --- PreToolUse hook: ExitPlanMode ---
    if (req.method === 'POST' && req.url === '/hook/exit-plan-mode') {
      readJsonBody(req, async (error, _body, data) => {
        if (error) { res.writeHead(400); res.end('Bad JSON'); return; }
        const { sessionId, channel, planContent, toolInput, dryRun, threadId } = data;
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
          const requestId = crypto.randomUUID();
          const result = await registerPlanApproval(requestId, channel, sessionId, resolvedPlan, toolInput || {}, dryRun === true, threadId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message }));
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

function startWebhookServer(options: {
  port?: number;
  host?: string;
  secret?: string;
} = {}) {
  const { port = PORT, host = '127.0.0.1' } = options;
  const server = http.createServer(createWebhookHandler(options));

  server.listen(port, host, () => {
    log.info(`Listening on ${host}:${port}/webhook/github`);
  });

  return server;
}

export { startWebhookServer, createWebhookHandler };
