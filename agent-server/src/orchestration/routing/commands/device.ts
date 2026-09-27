import type { PlatformAdapter, Destination } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import { getOnlineDevices } from '@domain/remote/client-manager.js';
import { getMachineRegistry } from '@domain/tasks/dispatch-utils.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import { formatTimeAgo } from './time-ago.js';

function buildDevicesText(): string {
  const onlineDevices = getOnlineDevices();
  const knownNames = new Set(Object.keys(getMachineRegistry()));
  for (const d of onlineDevices) knownNames.add(d.device);

  const now = Date.now();
  const lines: string[] = [t('cmd.device.header')];

  for (const name of [...knownNames].sort()) {
    const online = onlineDevices.find(d => d.device === name);
    if (online) {
      const connAgo = formatTimeAgo(now - online.connectedAt.getTime());
      const hbAgo = formatTimeAgo(now - online.lastHeartbeat.getTime());
      lines.push(`${Icons.ok} ${t('cmd.device.online', { name, platform: online.platform, connAgo, hbAgo })}`);
    } else {
      lines.push(`${Icons.error} ${t('cmd.device.offline', { name })}`);
    }
  }

  if (knownNames.size === 0) {
    lines.push(t('cmd.device.none'));
  }

  return lines.join('\n');
}

// Built per call so the label is resolved in the active locale (not frozen at import time).
const refreshButton = () => ({
  type: 'button' as const,
  text: t('cmd.device.refreshButton'),
  actionId: 'cmd:devices:refresh',
  value: 'refresh',
});

export function createDevicesHandler(router?: CommandActionRouter) {
  if (router) {
    router.registerCommand('devices', {
      actions: [{
        actionId: 'refresh',
        handler: async (ctx) => {
          const adapter = router.getAdapter();
          if (!adapter || !ctx.messageRef) return;
          const text = buildDevicesText();
          await adapter.updateMessage(ctx.messageRef, {
            text,
            richBlocks: [
              { type: 'section', text },
              { type: 'actions', elements: [refreshButton()] },
            ],
          }).catch(() => {});
        },
      }],
    });
  }

  return async function handleDevicesCmd(channel: string, adapter: PlatformAdapter): Promise<CommandResult | void> {
    const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
    const text = buildDevicesText();

    if (!router) {
      await adapter.postMessage(dest, { text });
      return;
    }

    return {
      text,
      richBlocks: [{ type: 'section' as const, text }],
      actions: [refreshButton()],
    };
  };
}

/** @deprecated Use createDevicesHandler() instead. */
export async function handleDevicesCmd(channel: string, adapter: PlatformAdapter): Promise<void> {
  const handler = createDevicesHandler();
  await handler(channel, adapter);
}
