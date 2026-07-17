import { createLogger } from '@core/log.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { closeSession, getActiveBackend, getActiveProfile } from '@domain/agents/index.js';

import { fireAndForgetPreCloseHook } from '@domain/sessions/session-hooks.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';

import { attachExistingSession, resetChannelSession } from '@domain/sessions/session-lifecycle.js';
import { planApprovals } from '../../interactions/plan-approvals.js';
import { interactionRecords } from '../../interactions/interaction-records.js';

const log = createLogger('session');

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Resolve the Slack thread timestamp for the session:
 *  1. Command-level threadAnchorId (user typed !new in-thread)
 *  2. Conversation ledger's last status message ts (session's thread parent)
 *  3. null (no thread context available) */
async function resolveSessionThreadTs(channel: string, threadAnchorId?: string | null): Promise<string | null> {
  if (threadAnchorId) return threadAnchorId;
  const conv = await conversationLedger.getConversation(channel);
  if (conv?.turns.length) {
    // Walk backwards to find the last turn with a statusMessageTs
    for (let i = conv.turns.length - 1; i >= 0; i--) {
      if (conv.turns[i].statusMessageTs) return conv.turns[i].statusMessageTs;
    }
  }
  return null;
}

export async function handleNewCmd(
  channel: string,
  adapter: PlatformAdapter,
  opts: { skipHook?: boolean } = {},
  threadAnchorId?: string | null,
): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (!opts.skipHook) {
    const resolvedThreadTs = await resolveSessionThreadTs(channel, threadAnchorId);
    void fireAndForgetPreCloseHook(channel, adapter, resolvedThreadTs);
  }

  closeSession(channel);
  const profileName = getActiveProfile(channel) || 'default';
  await resetChannelSession(channel);
  const cleared = planApprovals.clearByChannel(channel);
  if (cleared > 0) log.info('Cleared pending plan for channel:', channel);
  // Web interaction entities: mark any pending question/plan cancelled so every client's card
  // resolves (broadcasts session.interaction) instead of dangling.
  void interactionRecords.resolvePendingByChannel(channel, 'cancelled', 'command');
  log.info('New conversation started in channel:', channel);
  await adapter.postMessage(dest, { text: t('cmd.session.newConversation', { profile: profileName }) });
}

const MAX_RESUME_BUTTONS = 10;

export function createResumeHandler(router?: CommandActionRouter) {
  if (router) {
    const switchHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter) return;
      const name = ctx.value;
      const record = await sessionStore.lookupSession(name);
      if (!record) {
        if (ctx.messageRef) {
          await adapter.updateMessage(ctx.messageRef, {
            text: `${Icons.error} ${t('cmd.session.notFound', { name })}`,
          }).catch(() => {});
        }
        return;
      }
      await attachExistingSession(ctx.channelId, { sessionId: record.sessionId, sessionName: name, backend: record.backend, profileName: record.profileName });
      const profileNote = record.profileName ? t('cmd.session.profileNote', { profile: record.profileName }) : '';
      if (ctx.messageRef) {
        await adapter.updateMessage(ctx.messageRef, {
          text: `${Icons.refresh} ${t('cmd.session.switched', { name, profileNote })}`,
        }).catch(() => {});
      }
    };
    router.registerCommand('resume', {
      actions: Array.from({ length: MAX_RESUME_BUTTONS }, (_, i) => ({
        actionId: `switch-${i}`,
        handler: switchHandler,
      })),
    });
  }

  return async function handleResumeCmdInteractive(
    channel: string, adapter: PlatformAdapter, trimmedMessage: string,
  ): Promise<CommandResult | void> {
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    const args = trimmedMessage.split(/\s+/).slice(1);

    if (args.length > 0) {
      const name = args[0];
      const record = await sessionStore.lookupSession(name);
      if (!record) {
        await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.session.notFoundList', { name })}` });
        return;
      }
      await attachExistingSession(channel, { sessionId: record.sessionId, sessionName: name, backend: record.backend, profileName: record.profileName });
      const profileNote = record.profileName ? t('cmd.session.profileNote', { profile: record.profileName }) : '';
      await adapter.postMessage(dest, { text: `${Icons.refresh} ${t('cmd.session.switched', { name, profileNote })}` });
      return;
    }

    const sessions = await sessionStore.listRecentSessions(10);
    if (sessions.length === 0) {
      await adapter.postMessage(dest, { text: t('cmd.session.noSessions') });
      return;
    }
    const activeId = await sessionStore.getActiveSessionName(channel, getActiveBackend());
    const now = Date.now();
    const lines = [t('cmd.session.recentHeader')];
    for (const s of sessions) {
      const isActive = s.name === activeId;
      const activeTag = isActive ? t('cmd.session.activeTag') : '';
      const ago = formatTimeAgo(now - new Date(s.lastUsedAt).getTime());
      const label = s.label ? ` — ${s.label}` : '';
      const kind = s.kind === 'scheduled' ? ` ${Icons.scheduled}` : '';
      lines.push(`• \`${s.name}\`${activeTag}${kind}${label} — ${ago}`);
    }
    const text = lines.join('\n');

    if (!router) {
      await adapter.postMessage(dest, { text });
      return;
    }

    return {
      text,
      richBlocks: [{ type: 'section' as const, text }],
      actions: sessions.slice(0, MAX_RESUME_BUTTONS).map((s, i) => ({
        type: 'button' as const,
        text: s.name.length > 20 ? s.name.slice(0, 17) + '...' : s.name,
        actionId: `cmd:resume:switch-${i}`,
        value: s.name,
      })),
    };
  };
}

/** @deprecated Use createResumeHandler() instead. */
export async function handleResumeCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const handler = createResumeHandler();
  await handler(channel, adapter, trimmedMessage);
}
