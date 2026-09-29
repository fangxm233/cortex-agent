import type { Destination, PlatformAdapter } from '@platform/index.js';
import { statSync, openSync, readSync, closeSync } from 'fs';
import * as path from 'path';
import { moduleDir } from '@core/utils.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';

const DAEMON_LOG_PATH = path.join(moduleDir(import.meta.url), '..', '..', '..', '..', 'logs', 'daemon.log');

interface TailState {
  interval: ReturnType<typeof setInterval>;
  offset: number;
}

const activeTails = new Map<string, TailState>();

async function stopTail(channel: string, adapter: PlatformAdapter): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const active = activeTails.get(channel);
  if (!active) {
    await adapter.postMessage(dest, { text: t('cmd.tail.noActive') });
    return;
  }
  clearInterval(active.interval);
  activeTails.delete(channel);
  await adapter.postMessage(dest, { text: `${Icons.stopped} ${t('cmd.tail.stopped')}` });
}

async function sendInitialTailPreview(channel: string, adapter: PlatformAdapter): Promise<number | null> {
  const previewDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  try {
    const stat = statSync(DAEMON_LOG_PATH);
    const previewBytes = Math.min(4096, stat.size);
    const buf = Buffer.alloc(previewBytes);
    const fd = openSync(DAEMON_LOG_PATH, 'r');
    readSync(fd, buf, 0, previewBytes, stat.size - previewBytes);
    closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter(Boolean).slice(-30);
    await adapter.postMessage(previewDest, { text: `${Icons.scroll} ${t('cmd.tail.preview', { n: lines.length, content: lines.join('\n') })}` });
    return stat.size;
  } catch (err) {
    await adapter.postMessage(previewDest, { text: `${Icons.error} ${t('cmd.tail.cannotRead', { error: (err as Error).message })}` });
    return null;
  }
}

function startTailInterval(channel: string, adapter: PlatformAdapter, offset: number): void {
  const tailIntervalDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const interval = setInterval(async () => {
    try {
      const stat = statSync(DAEMON_LOG_PATH);
      const active = activeTails.get(channel);
      if (!active) return;
      if (stat.size <= active.offset) {
        if (stat.size < active.offset) active.offset = stat.size;
        return;
      }
      const bytesToRead = Math.min(stat.size - active.offset, 8192);
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(DAEMON_LOG_PATH, 'r');
      readSync(fd, buf, 0, bytesToRead, active.offset);
      closeSync(fd);
      active.offset += bytesToRead;
      const newContent = buf.toString('utf-8').trim();
      if (newContent) await adapter.postMessage(tailIntervalDest, { text: `\`\`\`\n${newContent}\n\`\`\`` });
    } catch {
      // File gone or unreadable — silently skip
    }
  }, 3000);
  activeTails.set(channel, { interval, offset });
}

export async function handleTailCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const args = trimmedMessage.split(/\s+/).slice(1);
  if (args[0] === 'stop') return stopTail(channel, adapter);
  const cmdDest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (activeTails.has(channel)) {
    await adapter.postMessage(cmdDest, { text: t('cmd.tail.alreadyTailing') });
    return;
  }
  const offset = await sendInitialTailPreview(channel, adapter);
  if (offset === null) return;
  startTailInterval(channel, adapter, offset);
}
