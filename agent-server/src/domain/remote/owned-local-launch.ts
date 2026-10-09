/** Owned-local launch coordination only. Existing lifecycle timers remain the sole retry owner. */
interface LaunchHooks {
  online(device: string): boolean;
  recover(device: string): Promise<void>;
  pidAlive(device: string): boolean;
  launch(device: string): void;
}
const RECONNECT_MS = 5_000;
const UNCONFIRMED_RECONNECT_MS = 1_000;
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
    const flight = this.prepareAndLaunch(device, this.controller.signal).finally(() => {
      if (this.flights.get(device) === flight) this.flights.delete(device);
    });
    this.flights.set(device, flight);
    return flight;
  }

  stop(): void { this.controller.abort(); this.flights.clear(); }
  resume(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }

  private async waitForReconnect(device: string, signal: AbortSignal): Promise<void> {
    // Self-update respawns the client, so a dead/missing recorded PID does not prove absence.
    const graceMs = this.hooks.pidAlive(device) ? RECONNECT_MS : UNCONFIRMED_RECONNECT_MS;
    const deadline = Date.now() + graceMs;
    while (!signal.aborted && !this.hooks.online(device) && Date.now() < deadline) await pause(signal);
  }

  private async prepareAndLaunch(device: string, signal: AbortSignal): Promise<void> {
    if (this.hooks.online(device)) return;
    await this.hooks.recover(device);
    if (signal.aborted || this.hooks.online(device)) return;
    await this.waitForReconnect(device, signal);
    if (signal.aborted || this.hooks.online(device)) return;
    this.hooks.launch(device);
  }
}
