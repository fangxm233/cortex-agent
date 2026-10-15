import { createLogger } from '@core/log.js';
import type { Destination, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import { formatTimeAgo } from './time-ago.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { resolveRunSelection } from '@domain/runs/config-resolver.js';
import { engines } from '@domain/runs/engines.js';

import { fireAndForgetPreCloseHook, resolveOnNewThreadAnchor } from '@domain/sessions/session-hooks.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import { shortSessionId } from '@core/short-session-id.js';

import { attachExistingSession, resetChannelSession } from '@domain/sessions/session-lifecycle.js';
import { planApprovals } from '../../interactions/plan-approvals.js';
import { interactionRecords } from '../../interactions/interaction-records.js';

const log = createLogger('session');

export async function handleNewCmd(
  channel: string,
  adapter: PlatformAdapter,
  opts: { skipHook?: boolean } = {},
  threadAnchorId?: string | null,
): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (!opts.skipHook) {
    const resolvedThreadTs = await resolveOnNewThreadAnchor(channel, threadAnchorId);
    void fireAndForgetPreCloseHook(channel, adapter, resolvedThreadTs);
  }

  void engines.close(channel);
  const selection = resolveRunSelection({ channel });
  await resetChannelSession(channel);
  const cleared = planApprovals.clearByChannel(channel);
  if (cleared > 0) log.info('Cleared pending plan for channel:', channel);
  // Web interaction entities: mark any pending question/plan cancelled so every client's card
  // resolves (broadcasts session.interaction) instead of dangling.
  void interactionRecords.resolvePendingByChannel(channel, 'cancelled', 'command');
  log.info('New conversation started in channel:', channel);
  await adapter.postMessage(dest, { text: t('cmd.session.newConversation', { selection: `${selection.backend} · ${selection.model}` }) });
}

const MAX_RESUME_BUTTONS = 10;

/** Full ID wins; a prefix must be long enough and identify exactly one live record. */
export async function resolveResumeSession(input: string): Promise<
  | { kind: 'found'; record: Session }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'not-found' }
> {
  const exact = await sessionStore.getById(input);
  if (exact) return { kind: 'found', record: exact };
  if (input.length < 6) return { kind: 'not-found' };
  const matches = (await sessionStore.listRecentSessions(Number.MAX_SAFE_INTEGER))
    .filter(record => record.sessionId.startsWith(input));
  if (matches.length === 1) return { kind: 'found', record: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', matches: matches.map(record => record.sessionId) };
  return { kind: 'not-found' };
}

export function createResumeHandler(router?: CommandActionRouter) {
  if (router) {
    const switchHandler = async (ctx: import('@platform/index.js').ActionContext) => {
      const adapter = router.getAdapter();
      if (!adapter) return;
      const id = ctx.value;
      const record = await sessionStore.getById(id);
      if (!record) {
        if (ctx.messageRef) {
          await adapter.updateMessage(ctx.messageRef, {
            text: `${Icons.error} ${t('cmd.session.notFound', { name: id })}`,
          }).catch(() => {});
        }
        return;
      }
      await attachExistingSession(ctx.channelId, { sessionId: record.sessionId, backend: record.backend, selection: record.selection });
      const selectionNote = record.selection ? ` (${record.selection.backend} · ${record.selection.model})` : '';
      if (ctx.messageRef) {
        await adapter.updateMessage(ctx.messageRef, {
          text: `${Icons.refresh} ${t('cmd.session.switched', { name: shortSessionId(record.sessionId), selectionNote })}`,
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
      const input = args[0];
      const resolved = await resolveResumeSession(input);
      if (resolved.kind === 'ambiguous') {
        await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.session.ambiguous', { name: input, matches: resolved.matches.join(', ') })}` });
        return;
      }
      if (resolved.kind === 'not-found') {
        await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.session.notFoundList', { name: input })}` });
        return;
      }
      const { record } = resolved;
      await attachExistingSession(channel, { sessionId: record.sessionId, backend: record.backend, selection: record.selection });
      const selectionNote = record.selection ? ` (${record.selection.backend} · ${record.selection.model})` : '';
      await adapter.postMessage(dest, { text: `${Icons.refresh} ${t('cmd.session.switched', { name: shortSessionId(record.sessionId), selectionNote })}` });
      return;
    }

    const sessions = await sessionStore.listRecentSessions(10);
    if (sessions.length === 0) {
      await adapter.postMessage(dest, { text: t('cmd.session.noSessions') });
      return;
    }
    const activeId = await sessionStore.getBoundSessionId(channel);
    const now = Date.now();
    const lines = [t('cmd.session.recentHeader')];
    for (const s of sessions) {
      const isActive = s.sessionId === activeId;
      const activeTag = isActive ? t('cmd.session.activeTag') : '';
      const ago = formatTimeAgo(now - new Date(s.lastUsedAt).getTime());
      const label = s.label ? ` — ${s.label}` : '';
      const kind = s.kind === 'scheduled' ? ` ${Icons.scheduled}` : '';
      lines.push(`• \`${shortSessionId(s.sessionId)}\`${activeTag}${kind}${label} — ${ago}`);
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
        text: shortSessionId(s.sessionId),
        actionId: `cmd:resume:switch-${i}`,
        value: s.sessionId,
      })),
    };
  };
}
