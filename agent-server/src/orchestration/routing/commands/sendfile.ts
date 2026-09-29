import type { Destination, PlatformAdapter } from '@platform/index.js';
import { getMachineRegistry } from '@domain/tasks/dispatch-utils.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import { statSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { WORKSPACE_DIR } from '@core/paths.js';

async function sendLocalFile(channel: string, adapter: PlatformAdapter, reg: any, filePath: string, machine: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  let resolved: string;
  if (filePath.startsWith('~/') || filePath === '~') {
    resolved = filePath.replace(/^~/, process.env.HOME || os.homedir());
  } else if (path.isAbsolute(filePath)) {
    resolved = filePath;
  } else {
    resolved = path.resolve(reg.cortexPath, filePath);
  }
  if (!existsSync(resolved)) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.sendfile.fileNotFound', { path: resolved })}` });
    return;
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.sendfile.notAFile', { path: resolved })}` });
    return;
  }
  await adapter.uploadFile(dest, resolved, { filename: path.basename(resolved) });
  await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.sendfile.sent', { name: path.basename(resolved), size: (stat.size / 1024).toFixed(1), machine })}` });
}

async function sendRemoteFile(channel: string, adapter: PlatformAdapter, reg: any, filePath: string, machine: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  let remotePath: string;
  if (filePath.startsWith('~/') || filePath === '~') {
    remotePath = filePath;
  } else if (path.isAbsolute(filePath) || (reg.win && /^[A-Z]:\\/i.test(filePath))) {
    remotePath = filePath;
  } else {
    remotePath = reg.win ? `${reg.cortexPath}\\${filePath}` : `${reg.cortexPath}/${filePath}`;
  }
  const tmpDir = path.join(WORKSPACE_DIR, 'sendfile');
  mkdirSync(tmpDir, { recursive: true });
  const fileName = path.basename(remotePath);
  const localTmp = path.join(tmpDir, `${Date.now()}-${fileName}`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('scp', [
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=no',
        `${reg.ssh}:${remotePath}`,
        localTmp,
      ], { timeout: 60000 }, (err) => {
        if (err) reject(new Error(`SCP failed: ${err.message}`));
        else resolve();
      });
    });
  } catch (err) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.sendfile.fetchFailed', { machine, error: (err as Error).message })}` });
    return;
  }
  try {
    const tmpStat = statSync(localTmp);
    await adapter.uploadFile(dest, localTmp, { filename: fileName });
    await adapter.postMessage(dest, { text: `${Icons.ok} ${t('cmd.sendfile.sent', { name: fileName, size: (tmpStat.size / 1024).toFixed(1), machine })}` });
  } finally {
    try { unlinkSync(localTmp); } catch {}
  }
}

export async function handleSendFileCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const args = trimmedMessage.split(/\s+/).slice(1);
  if (args.length < 2) {
    await adapter.postMessage(dest, { text: t('cmd.sendfile.usage') });
    return;
  }
  const machine = args[0];
  const filePath = args.slice(1).join(' ');
  const reg = getMachineRegistry()[machine];
  if (!reg) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.sendfile.unknownMachine', { machine, known: Object.keys(getMachineRegistry()).join(', ') })}` });
    return;
  }
  if (!reg.ssh) return sendLocalFile(channel, adapter, reg, filePath, machine);
  return sendRemoteFile(channel, adapter, reg, filePath, machine);
}
