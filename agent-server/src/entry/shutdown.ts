// Graceful SIGTERM shutdown: an ordered list of steps, each run even when an earlier one fails.
import { createLogger } from '@core/log.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { CORTEX_VERSION } from '@core/version.js';
import { flushAllRepositories } from '@core/json-repository.js';
import { engines } from '@domain/runs/engines.js';
import { stopBuiltinJobs } from '@domain/scheduling/builtin-jobs.js';
import { stopClientManager } from '@domain/remote/client-manager.js';
import { stopMachineRegistryWatcher } from '@domain/remote/machine-registry.js';
import { stopAllDevicePorts } from '@domain/remote/device-port.js';
import { forgetDeviceBrowsers } from '@domain/remote/device-browser.js';
import { stopDiskMonitor } from '@domain/monitor/disk-monitor.js';
import { stopEventLoopMonitor } from '@domain/monitor/event-loop-monitor.js';
import { stopGateway } from '@domain/costs/gateway-manager.js';
import { stopBrowser } from '@platform/browser/managed-browser.js';
import { stopWaitpointSweep } from '../orchestration/waitpoint-sweep.js';

const log = createLogger('shutdown');

export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

/** What the steps stop. Boot fills the optional ones as it brings each service up. */
export interface ShutdownHandles {
  bus: { close(): unknown };
  outboundQueue: { stop(): Promise<void>; flush(): Promise<void> };
  scheduler: { stop(): void };
  retention: { stop(): Promise<void> };
  platformConnections?: { stop(): Promise<void> } | null;
  uiHttpServer?: { close(): Promise<void> } | null;
  stopProfileWatcher?: (() => void) | null;
  stopBoardWatcher?: (() => void) | null;
}

function serviceSteps(h: ShutdownHandles): ShutdownStep[] {
  return [
    { name: 'announce', run: () => { void emitCortexEvent('cortex:server.shutdown', { version: CORTEX_VERSION, pid: process.pid, reason: 'SIGTERM' }).catch(() => {}); } },
    { name: 'builtin jobs', run: stopBuiltinJobs },
    { name: 'platforms', run: () => h.platformConnections?.stop() },
    { name: 'retention sweep', run: () => h.retention.stop() },
    { name: 'agent engines', run: () => engines.closeAll() },
    { name: 'client manager', run: stopClientManager },
    { name: 'machine watcher', run: stopMachineRegistryWatcher },
    { name: 'profile watcher', run: () => h.stopProfileWatcher?.() },
    { name: 'board watcher', run: () => h.stopBoardWatcher?.() },
    // A Chrome that outlives the daemon keeps the profile locked, so the next launch would attach to
    // an instance nothing is supervising.
    { name: 'browser', run: stopBrowser },
    // Device ports are loopback listeners held by this process; nothing reclaims them on its behalf.
    { name: 'device ports', run: stopAllDevicePorts },
    // A device's Chrome is on someone else's machine and is not ours to kill on the way out; the next
    // acquire re-verifies, so leaving it running costs a window and nothing else.
    { name: 'device browsers', run: forgetDeviceBrowsers },
    { name: 'web ui', run: () => h.uiHttpServer?.close() },
    { name: 'disk monitor', run: stopDiskMonitor },
    { name: 'event-loop monitor', run: stopEventLoopMonitor },
  ];
}

function drainSteps(h: ShutdownHandles): ShutdownStep[] {
  return [
    // Timers stop BEFORE the stores drain — otherwise a late-firing timer can enqueue a write after
    // its store's flush resolved, losing that write.
    { name: 'scheduler', run: () => h.scheduler.stop() },
    { name: 'waitpoint sweep', run: stopWaitpointSweep },
    // Pending WAL entries survive on disk for the next startup.
    { name: 'outbound drain loop', run: () => h.outboundQueue.stop() },
    // SIGTERM landing between `writeFile(tmp)` and `rename(tmp, target)` in atomic-write.ts leaves
    // orphan .tmp.* siblings; the daemon gives 5s before SIGKILL, well over what this needs.
    { name: 'flush stores', run: () => Promise.allSettled([h.bus.close(), h.outboundQueue.flush(), flushAllRepositories()]) },
    { name: 'gateway', run: stopGateway },
  ];
}

export function shutdownSteps(h: ShutdownHandles): ShutdownStep[] {
  return [...serviceSteps(h), ...drainSteps(h)];
}

export async function runShutdown(steps: ShutdownStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      log.warn(`Shutdown step "${step.name}" failed: ${(error as Error).message}`);
    }
  }
}

/** Run the shutdown steps on SIGTERM, then exit 0. */
export function installSigtermShutdown(h: ShutdownHandles): void {
  process.on('SIGTERM', () => {
    void runShutdown(shutdownSteps(h)).then(() => process.exit(0));
  });
}
