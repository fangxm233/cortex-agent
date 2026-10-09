/** Owned-local launch coordination only. Existing lifecycle timers remain the sole retry owner. */
interface LaunchHooks {
  online(device: string): boolean;
  /** Return the persisted launchAttempted field; only false can skip reconnect grace. */
  recover(device: string, signal: AbortSignal): Promise<boolean | undefined>;
  markLaunchAttempted(device: string, signal: AbortSignal): Promise<void>;
  launch(device: string): void;
}
// client/src/client.ts caps scheduleReconnect at 30s; leave 5s for connection/hello.
const RECONNECT_MS = 35_000;
const POLL_MS = 250;

export function ownedLocalEnvironment(
  inherited: NodeJS.ProcessEnv,
  home: string,
  token: string | undefined,
  port: number | null,
): NodeJS.ProcessEnv {
  if (!token?.trim()) throw new Error('Local client requires the authoritative client token');
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Client manager port is not ready');
  return { ...inherited, CORTEX_HOME: home, CORTEX_CLIENT_TOKEN: token, CORTEX_SERVER_URL: `ws://127.0.0.1:${port}` };
}

function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, POLL_MS);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class OwnedLocalLaunchGate {
  private controller = new AbortController();
  private flights = new Map<string, Promise<void>>();
  constructor(private readonly hooks: LaunchHooks) {}

  start(device: string): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    const existing = this.flights.get(device);
    if (existing) return existing;
    const signal = this.controller.signal;
    const flight = this.prepareAndLaunch(device, signal)
      .catch(error => { if (!signal.aborted) throw error; })
      .finally(() => { if (this.flights.get(device) === flight) this.flights.delete(device); });
    this.flights.set(device, flight);
    return flight;
  }

  stop(): void { this.controller.abort(); this.flights.clear(); }
  resume(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }

  private async waitForReconnect(device: string, signal: AbortSignal): Promise<void> {
    // Self-update can obsolete the recorded PID; possibly launched clients always get this grace.
    const deadline = Date.now() + RECONNECT_MS;
    while (!signal.aborted && !this.hooks.online(device) && Date.now() < deadline) await pause(signal);
  }

  private async prepareAndLaunch(device: string, signal: AbortSignal): Promise<void> {
    if (this.hooks.online(device)) return;
    const launchAttempted = await this.hooks.recover(device, signal);
    if (signal.aborted || this.hooks.online(device)) return;
    if (launchAttempted !== false) await this.waitForReconnect(device, signal);
    await this.launchIfOffline(device, signal);
  }

  private async launchIfOffline(device: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.hooks.online(device)) return;
    await this.hooks.markLaunchAttempted(device, signal);
    if (signal.aborted || this.hooks.online(device)) return;
    this.hooks.launch(device);
  }
}
