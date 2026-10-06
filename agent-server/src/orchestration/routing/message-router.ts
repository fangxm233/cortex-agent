import type { PlatformAdapter, IncomingMessage, MessageEditContext } from '@platform/index.js';
import { createLogger } from '@core/log.js';
import { extractForwardedContent } from '../status-helpers.js';

const log = createLogger('app');
import { orchestrator } from '../orchestrator.js';

export interface MessageHandlerDeps {
  dispatchCommand: (text: string | undefined, channel: string, adapter: PlatformAdapter, threadAnchorId?: string | null) => boolean;
  handleMessageEdit: (ctx: MessageEditContext, adapter: PlatformAdapter) => void;
}

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
  if (dispatchCommand(commandMessage, channel, adapter, threadAnchorId)) return;

  const agentMessage = buildAgentMessage(userMessage || '', forwardedContent);
  await orchestrator.handleMessage({
    message, channel, adapter, threadAnchorId, hasFiles,
    userMessage: userMessage || '', agentMessage,
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
  if (!forwardedContent) return userMessage;
  const fallback = userMessage || 'The user forwarded the above message to you.';
  return `[Forwarded message]\n${forwardedContent}\n[End forwarded message]\n\n${fallback}`;
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
