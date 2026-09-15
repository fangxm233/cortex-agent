// input:  the thread-executor's per-message context (ThreadExecCtx) + the user's text / files
// output: platform files downloaded to disk, and pending-user-inputs buffered for the next step
// pos:    orchestration — the file-download + message-buffering helpers thread-executor hands off
//         to. Holds the ThreadExecCtx shape so nothing here imports thread-executor (the executor
//         imports these; a back-edge, even type-only, would close a depcruise cycle).

import { randomUUID } from 'node:crypto';
import type { Destination, PlatformAdapter, IncomingMessage } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../core/icons.js';
import { evictPendingUserInput, registerPendingUserInput } from '@domain/threads/pending-user-inputs.js';
import {
  downloadFiles as downloadPlatformFiles, inboundAttachmentKey, type InboundFiles,
} from './routing/file-handler.js';
import { threadStore } from '@store/thread-repo.js';
import { buildPrompt as buildAgentPrompt } from '../agent-adapter/normalize/prompt-builder.js';
// Same tag as thread-executor's logger on purpose: these lines used to be emitted from there.
const log = createLogger('thread-executor');

export interface ThreadExecCtx {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  agentMessage: string;
  threadAddMatch: RegExpMatchArray | null;
  threadStartMatch: RegExpMatchArray | null;
  existingThread: any;
  isActiveThread: boolean;
}

// --- Shared helper ---

export async function downloadFiles(message: IncomingMessage, hasFiles: boolean, adapter: PlatformAdapter): Promise<InboundFiles> {
  if (!hasFiles || !message.files) return { files: [], failures: [] };
  return downloadPlatformFiles(message.files, adapter, inboundAttachmentKey(message));
}

// --- Message buffering (Phase 6) ---

/** Reserve user input synchronously so the runner sees it before the current step exits. */
function reserveUserInput(thread: any, text: string): { inputId: string; evictedInputId: string | null } {
  const inputId = `buf_${randomUUID()}`;
  if (!thread.metadata) thread.metadata = {};
  const inputs = thread.metadata.pendingUserInputs ??= [];
  const evictedInputId = inputs.length >= 10 ? inputs.shift()?.id ?? null : null;
  inputs.push({ id: inputId, text });
  threadStore.set(thread).catch(() => {});
  return { inputId, evictedInputId };
}

async function prepareUserInput(ctx: ThreadExecCtx, inputId: string, text: string): Promise<void> {
  const { files, failures } = await downloadFiles(ctx.message, ctx.hasFiles, ctx.adapter);
  const thread = threadStore.get(ctx.existingThread.id);
  const input = thread?.metadata?.pendingUserInputs?.find((entry) => entry.id === inputId);
  if (!thread || !input) return;
  input.text = buildAgentPrompt(text, files.map((file) => ({
    mimeType: file.mimetype,
    path: file.localPath,
    name: file.name,
  })), failures);
  await threadStore.set(thread);
}

/** Buffer user text plus downloaded files for the next thread step. */
export async function bufferUserMessage(ctx: ThreadExecCtx): Promise<void> {
  const { adapter, channel, threadAnchorId } = ctx;
  const text = ctx.agentMessage || ctx.message.text || '';
  const { inputId, evictedInputId } = reserveUserInput(ctx.existingThread, text);
  if (evictedInputId) evictPendingUserInput(ctx.existingThread.id, evictedInputId);
  const preparation = prepareUserInput(ctx, inputId, text);
  registerPendingUserInput(ctx.existingThread.id, inputId, preparation);
  await preparation.catch((error) => log.warn(`Failed to prepare buffered input: ${(error as Error).message}`));
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  await adapter.postMessage(dest, {
    text: `${Icons.inbox} Message buffered — will be included in the next step’s prompt`,
  }, threadAnchorId ? { threadId: threadAnchorId } : undefined);
}
