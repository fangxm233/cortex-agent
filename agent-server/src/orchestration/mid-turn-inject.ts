// input:  live run lookup, platform files, path/pending seams
// output: injected turns, remote device and subagent metadata
// pos:    Busy-channel injection branch of AgentRunner.route
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/**
 * Mid-turn user-message injection router. P1.8 moved the injection itself onto `AgentRun.steer()`
 * (which installs the backend `InjectionAckSink` and fans acks out as `injection_delivered` /
 * `injection_rejected` RunEvents) and the durable two-phase persistence into
 * `orchestration/transcript-sink.ts` (the injection ledger, driven by those events).
 *
 * This module only decides *whether* to inject: the cheapest gates first, the run lookup second,
 * then it hands the message to the run and registers the pending record with the ledger. Every
 * refusal leaves no trace so the caller falls through to the normal queue.
 */

import { randomUUID } from 'node:crypto';
import { Capability, CAPABILITIES_BY_BACKEND } from '../agent-adapter/capabilities.js';
import type { Backend, UserMessage } from '../agent-adapter/types.js';
import { buildPrompt as buildAgentPrompt } from '../agent-adapter/normalize/prompt-builder.js';
import { SYNTHETIC_CALLBACK_SENDER } from '@platform/types.js';
import type { AttachmentMeta } from '@domain/ui-service/types.js';
import type { PendingInjectionRecord } from '@store/pending-injection-repo.js';
import { resolveWorkspaceRelPath } from '@core/paths.js';
import type { AgentRun } from '../domain/runs/run.js';
import {
  beginInjection, ensureInjectionObserver, resetInjectionLedger,
  type InjectionLedgerDeps,
} from './transcript-sink.js';

/** The subset of a live registry entry this path needs. The run decides capability itself. */
export interface LiveExecutionLike {
  backend: string;
  run?: AgentRun;
}

/** Everything the injection ledger and the router need, bound by `buildInjectDeps`. */
export interface MidTurnInjectDeps extends InjectionLedgerDeps {
  getLiveExecutions: (channel: string) => LiveExecutionLike[];
  createPendingId?: () => string;
}

export interface MidTurnInjectCtx {
  channel: string;
  /** Stable Cortex track session id. Null (never-used channel) ⇒ nothing to surface against. */
  sessionId: string | null;
  sessionName?: string | null;
  profileName?: string | null;
  text: string;
  senderId: string;
  /** The inbound platform message id — the ledger turn's key. */
  messageId: string;
  attachments?: AttachmentMeta[];
  /** Lazily download platform-native files only after an injectable target is selected. */
  prepareBackendAttachments?: () => Promise<UserMessage['attachments']>;
}

/** Only plain human messages may fold into an in-flight turn. Commands and synthetic session
 * re-entry messages own separate dispatch semantics; edits kill the live execution before routing. */
export function isInjectableMessage(opts: { text: string; senderId: string }): boolean {
  const text = (opts.text ?? '').trim();
  if (!text) return false;
  if (text.startsWith('!')) return false;
  if (opts.senderId === SYNTHETIC_CALLBACK_SENDER) return false;
  return true;
}

/** True when the backend declares `Capability.MidTurnInject`. */
export function backendSupportsInject(backend: string): boolean {
  return !!CAPABILITIES_BY_BACKEND[backend as Backend]?.has(Capability.MidTurnInject);
}

/** The newest live run on the channel. Capability is enforced by `run.steer()`, not inspected here. */
function selectInjectRun(execs: LiveExecutionLike[]): { run: AgentRun; backend: string } | null {
  let best: { run: AgentRun; backend: string } | null = null;
  for (const exec of execs) {
    if (exec.run) best = { run: exec.run, backend: exec.backend };
  }
  return best;
}

function buildPendingRecord(
  deps: MidTurnInjectDeps,
  ctx: MidTurnInjectCtx,
  message: UserMessage,
  sessionId: string,
  backend: string,
  ts: string,
): PendingInjectionRecord {
  return {
    id: deps.createPendingId?.() ?? randomUUID(),
    sessionId,
    channel: ctx.channel,
    messageId: ctx.messageId,
    sessionName: ctx.sessionName ?? null,
    backend,
    profileName: ctx.profileName ?? null,
    text: ctx.text,
    attachments: ctx.attachments,
    ...(deps.captureDebug ? { agentMessage: buildAgentPrompt(message.text, message.attachments ?? []) } : {}),
    createdAt: ts,
  };
}

/**
 * Try to deliver `ctx` into the turn already running on its channel.
 *
 * Returns true when the message was accepted by the backend — the caller must then NOT enqueue it.
 * Every rejection path (no live turn, incapable backend, non-plain message, backend refusal)
 * returns false and leaves no trace, so the caller falls through to today's queue behaviour.
 */
export async function tryInjectIntoLiveTurn(
  deps: MidTurnInjectDeps,
  ctx: MidTurnInjectCtx,
): Promise<boolean> {
  if (!isInjectableMessage(ctx) || !ctx.sessionId) return false;
  const target = selectInjectRun(deps.getLiveExecutions(ctx.channel));
  if (!target) return false;
  const platformAttachments = ctx.prepareBackendAttachments
    ? await ctx.prepareBackendAttachments()
    : undefined;
  const message = prepareBackendMessage(ctx, platformAttachments);
  const record = buildPendingRecord(deps, ctx, message, ctx.sessionId, target.backend, deps.now());
  const outcome = await target.run.steer(message, record.id);
  if (outcome === 'refused') return false;
  // Subscribe first so the ack cannot race the ledger's phase-one registration, then persist the
  // provisional row. The run keeps the message in its own pending list until the ack arrives.
  ensureInjectionObserver(deps, ctx.channel, ctx.sessionId, target.run);
  await beginInjection(deps, record);
  return true;
}

function prepareBackendMessage(
  ctx: MidTurnInjectCtx,
  platformAttachments: UserMessage['attachments'],
): UserMessage {
  const platform = platformAttachments ?? [];
  const web = attachmentsForBackend(ctx.attachments) ?? [];
  const attachments = [...platform, ...web];
  return { text: ctx.text, attachments: attachments.length > 0 ? attachments : undefined };
}

/** Resolve UI attachment aliases before handing files to the backend. */
function attachmentsForBackend(attachments?: AttachmentMeta[]): UserMessage['attachments'] {
  if (!attachments?.length) return undefined;
  const resolved = attachments.flatMap((attachment) => {
    const localPath = resolveWorkspaceRelPath(attachment.path);
    return localPath ? [{ mimeType: attachment.mimeType, path: localPath }] : [];
  });
  return resolved.length > 0 ? resolved : undefined;
}

/** Test hook: drop all per-channel injection state. */
export const _test = {
  reset(): void { resetInjectionLedger(); },
};
