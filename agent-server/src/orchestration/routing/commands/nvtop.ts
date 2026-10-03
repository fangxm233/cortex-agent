import type { Destination, PlatformAdapter } from '@platform/index.js';
import { queryGpuSnapshot, renderGpuSnapshot } from '@domain/monitor/gpu-monitor.js';
import { getMachineRegistry, getLocalMachine } from '@domain/remote/machine-registry.js';
import { sendCommand, isDeviceOnline } from '@domain/remote/client-manager.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';

const NVTOP_REFRESH_MS = 1000;
const NVTOP_HISTORY_LIMIT = 12;

const activeNvtopMonitors = new Map<string, {
  interval: ReturnType<typeof setInterval>;
  machine: string;
  trackingTs: string;
  historyByGpu: Map<string, number[]>;
}>();

function rememberGpuHistory(historyByGpu: Map<string, number[]>, snapshot: { gpus: { uuid: string; utilPercent: number }[] }): void {
  for (const gpu of snapshot.gpus) {
    const history = historyByGpu.get(gpu.uuid) || [];
    history.push(gpu.utilPercent);
    if (history.length > NVTOP_HISTORY_LIMIT) history.shift();
    historyByGpu.set(gpu.uuid, history);
  }
}

async function updateNvtopMessage(channel: string, adapter: PlatformAdapter): Promise<void> {
  const active = activeNvtopMonitors.get(channel);
  if (!active) return;
  const snapshot = await queryGpuSnapshot(active.machine);
  rememberGpuHistory(active.historyByGpu, snapshot);
  const text = renderGpuSnapshot(snapshot, active.historyByGpu, NVTOP_REFRESH_MS / 1000);
  await adapter.updateMessage({ conduit: channel, messageId: active.trackingTs }, { text });
}

export async function handleNvidiaSmiCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const args = trimmedMessage.split(/\s+/).slice(1);
  const machine = args[0] || getLocalMachine();
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  const reg = getMachineRegistry()[machine];
  if (!reg) {
    const valid = Object.keys(getMachineRegistry()).filter(m => getMachineRegistry()[m].gpuCount > 0).map(m => `\`${m}\``).join(', ');
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.unknownMachineGpu', { machine, valid })}` });
    return;
  }
  if (reg.gpuCount === 0) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.noGpu', { machine })}` });
    return;
  }
  if (!isDeviceOnline(machine)) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.deviceOffline', { machine })}` });
    return;
  }
  try {
    const result = await sendCommand(machine, { action: 'bash', params: { command: 'nvidia-smi' }, timeout: 15000 });
    const output = result.stdout || result.stderr || t('cmd.nvtop.noOutput');
    await adapter.postMessage(dest, { text: t('cmd.nvtop.smiHeader', { machine, output }) });
  } catch (err) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.smiFailed', { machine, error: (err as Error).message })}` });
  }
}

export async function handleNvtopCmd(channel: string, adapter: PlatformAdapter, trimmedMessage: string): Promise<void> {
  const args = trimmedMessage.split(/\s+/).slice(1);
  const dest: Destination = { type: 'interactive-reply', conduit: channel, sessionId: '' };
  if (args[0] === 'stop') {
    const active = activeNvtopMonitors.get(channel);
    if (!active) {
      await adapter.postMessage(dest, { text: t('cmd.nvtop.noActive') });
      return;
    }
    clearInterval(active.interval);
    activeNvtopMonitors.delete(channel);
    await adapter.postMessage(dest, { text: `${Icons.stopped} ${t('cmd.nvtop.stopped', { machine: active.machine })}` });
    return;
  }

  if (activeNvtopMonitors.has(channel)) {
    await adapter.postMessage(dest, { text: t('cmd.nvtop.alreadyRunning') });
    return;
  }

  const machine = args[0] || getLocalMachine();
  const reg = getMachineRegistry()[machine];
  if (!reg) {
    const valid = Object.keys(getMachineRegistry()).filter(m => getMachineRegistry()[m].gpuCount > 0).map(m => `\`${m}\``).join(', ');
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.unknownMachineGpu', { machine, valid })}` });
    return;
  }
  if (reg.gpuCount === 0) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.notSupported', { machine })}` });
    return;
  }

  try {
    const historyByGpu = new Map<string, number[]>();
    const snapshot = await queryGpuSnapshot(machine);
    rememberGpuHistory(historyByGpu, snapshot);
    const text = renderGpuSnapshot(snapshot, historyByGpu, NVTOP_REFRESH_MS / 1000);
    const result = await adapter.postMessage(dest, { text });
    const interval = setInterval(async () => {
      try {
        await updateNvtopMessage(channel, adapter);
      } catch {
        // Keep monitor alive; next refresh may recover.
      }
    }, NVTOP_REFRESH_MS);
    activeNvtopMonitors.set(channel, {
      interval,
      machine,
      trackingTs: result.messageId,
      historyByGpu,
    });
  } catch (err) {
    await adapter.postMessage(dest, { text: `${Icons.error} ${t('cmd.nvtop.failed', { machine, error: (err as Error).message })}` });
  }
}
