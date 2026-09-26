import type { Destination, PlatformAdapter } from '@platform/index.js';
import { threadStore } from '@store/thread-repo.js';
import { resolveProfile } from '@domain/agents/profile-manager.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';

export async function handleDispatchCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const args = trimmedMessage.split(/\s+/).slice(1);
  if (args.length === 0) {
    await adapter.postMessage(dest, { text: t('cmd.dispatch.usage') });
    return;
  }

  const threadId = args[0];
  const thread = threadStore.get(threadId);
  if (!thread) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.dispatch.threadNotFound', { threadId })}` });
    return;
  }
  if (thread.metadata?.trigger !== 'task-dispatch') {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.dispatch.notDispatchThread', { threadId })}` });
    return;
  }
  if (thread.status === 'completed' || thread.status === 'failed' || thread.status === 'cancelled' || thread.status === 'aborted') {
    await adapter.postMessage(dest, {
      text: `${Icons.warning} ${t('cmd.dispatch.terminalWarning', { threadId: threadId.substring(0, 12), status: thread.status })}`,
    });
    // Allow the change to go through even for completed threads — it takes effect if continued.
  }

  const profileIdx = args.indexOf('--profile');
  if (profileIdx === -1 || profileIdx + 1 >= args.length) {
    const current = thread.metadata?.profileOverride || '(not set)';
    await adapter.postMessage(dest, { text: `${t('cmd.dispatch.currentOverride', { threadId: threadId.substring(0, 12), current })}\n${t('cmd.dispatch.usage')}` });
    return;
  }

  const profileName = args[profileIdx + 1];
  try {
    resolveProfile(profileName);
  } catch {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.dispatch.unknownProfile', { profile: profileName })}` });
    return;
  }

  await threadStore.mutate(threadId, (th) => {
    th.metadata = { ...th.metadata, profileOverride: profileName };
  });

  await adapter.postMessage(dest, {
    text: `${Icons.ok} ${t('cmd.dispatch.overrideSet', { threadId: threadId.substring(0, 12), profile: profileName })}`,
  });
}
