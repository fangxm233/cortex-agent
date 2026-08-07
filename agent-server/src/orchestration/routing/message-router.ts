// input:  platform messages, command dispatcher, thread store
// output: registerMessageHandler with normalized command routing
// pos:    Shared Slack and Feishu message router
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { PlatformAdapter, IncomingMessage, MessageEditContext } from '@platform/index.js';
import { normalizeSkillCommandPrefix } from '@domain/memory/skill-scanner.js';
import { createLogger } from '@core/log.js';
import { extractForwardedContent } from '../status-helpers.js';
import { threadStore } from '@store/thread-repo.js';

const log = createLogger('app');
import { getTemplate, getAgent } from '@domain/threads/index.js';
import { orchestrator } from '../orchestrator.js';

export interface MessageHandlerDeps {
  dispatchCommand: (text: string | undefined, channel: string, adapter: PlatformAdapter, threadAnchorId?: string | null) => boolean;
  handleMessageEdit: (ctx: MessageEditContext, adapter: PlatformAdapter) => void;
}

const THREAD_RESERVED_SUBCOMMANDS = new Set(['cancel', 'list', 'agents', 'templates']);
const COMMAND_MENTION_TOKEN = /(^|\s+)(?:<@[^>\s]+>|@[^\s@]+)(?=\s|$)/g;

export function registerMessageHandler(adapter: PlatformAdapter, deps: MessageHandlerDeps): void {
  adapter.onMessageEdit(async (ctx) => {
    deps.handleMessageEdit(ctx, adapter);
  });
  adapter.onMessage((ctx) => routeIncomingMessage(ctx.message, adapter, deps.dispatchCommand));
}

async function routeIncomingMessage(
  message: IncomingMessage,
  adapter: PlatformAdapter,
  dispatchCommand: MessageHandlerDeps['dispatchCommand'],
): Promise<void> {
  log.info('Message event:', JSON.stringify({ kind: message.kind, isBot: message.isBot, text: message.text?.substring(0, 50), files: message.files?.length, threadId: message.ref.threadId }));
  if (!shouldRouteIncomingMessage(message)) return;

  const hasFiles = (message.files?.length || 0) > 0;
  const userMessage = message.text;
  const forwardedContent = extractForwardedContent(message);
  if (!userMessage && !hasFiles && !forwardedContent) return;

  const channel = message.ref.conduit;
  const threadAnchorId = message.ref.threadId || null;
  const commandMessage = normalizeCommandMentions(userMessage?.trim());
  if (shouldSkipForCommandDispatch(commandMessage, dispatchCommand, channel, adapter, threadAnchorId)) return;

  const agentMessage = buildAgentMessage(userMessage || '', forwardedContent);
  const threadRouting = buildThreadRouting(commandMessage, channel, threadAnchorId);
  await orchestrator.handleMessage({
    message, channel, adapter, threadAnchorId, hasFiles,
    userMessage: userMessage || '', agentMessage, ...threadRouting,
  });
}

function shouldRouteIncomingMessage(message: IncomingMessage): boolean {
  if (!routeBotMessage(message) && message.isBot) return false;
  return message.kind !== 'system';
}

function buildAgentMessage(
  userMessage: string,
  forwardedContent: ReturnType<typeof extractForwardedContent>,
): string {
  const agentMessage = normalizeSkillCommandPrefix(userMessage);
  if (!forwardedContent) return agentMessage;
  const fallback = agentMessage || 'The user forwarded the above message to you.';
  return `[Forwarded message]\n${forwardedContent}\n[End forwarded message]\n\n${fallback}`;
}

function buildThreadRouting(commandMessage: string | undefined, channel: string, threadAnchorId: string | null) {
  const threadAddMatch = commandMessage?.match(/^!thread\s+add\s+(\S+)(?:\s+([\s\S]+))?$/) ?? null;
  const threadStartMatch = commandMessage?.match(/^!thread\s+(\S+)\s+([\s\S]+)/) ?? null;
  const existingThread = threadAnchorId ? threadStore.findByPlatformThread(channel, threadAnchorId) : null;
  const isActiveThread = !!(existingThread && (existingThread.status === 'running' || existingThread.status === 'waiting'));
  return { threadAddMatch, threadStartMatch, existingThread, isActiveThread };
}

// --- Bot message filter ---

function routeBotMessage(message: IncomingMessage): boolean {
  if (!message.isBot) return false;
  if (message.text?.startsWith('[BRANCH_CALLBACK]')) {
    // Intentional mutation: downstream `userMessage = message.text` must see the cleaned text
    message.text = message.text.replace('[BRANCH_CALLBACK]', '').trim();
    return true;
  }
  return false;
}

// --- Command dispatch check ---

function normalizeCommandMentions(message: string | undefined): string | undefined {
  if (!message) return message;
  const withoutMentions = message.replace(COMMAND_MENTION_TOKEN, '').trim();
  return withoutMentions.startsWith('!') ? withoutMentions : message;
}

function shouldSkipForCommandDispatch(trimmedMessage: string | undefined, dispatchCommand: MessageHandlerDeps['dispatchCommand'], channel: string, adapter: PlatformAdapter, threadAnchorId: string | null): boolean {
  const threadAddMatch = trimmedMessage?.match(/^!thread\s+add\s+(\S+)(?:\s+([\s\S]+))?$/);
  const isThreadExecCmd = (() => {
    if (threadAddMatch) return true;
    const m = trimmedMessage?.match(/^!thread\s+(\S+)\s+([\s\S]+)/);
    if (!m || THREAD_RESERVED_SUBCOMMANDS.has(m[1])) return false;
    return getTemplate(m[1]) != null || getAgent(m[1]) != null;
  })();
  return !isThreadExecCmd && dispatchCommand(trimmedMessage, channel, adapter, threadAnchorId);
}
