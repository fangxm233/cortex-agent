import { compareCalVer } from '@core/calver.js';
import { getSettings } from '@core/settings.js';
import { CORTEX_VERSION } from '@core/version.js';
import type { UpdateChoice, UpdatePrompt } from './update-prompt.js';
import type { UpdateState } from './update-state.js';
import { getServerUpdateStatus, reportServerUpdateFailed } from './update-ui-state.js';

export interface SystemUpdateCheckResult {
  status: 'available' | 'current' | 'skipped' | 'error';
  update?: { version: string };
  reason?: string;
}

export interface ServerUpdateCoordinatorDeps {
  prompt: UpdatePrompt;
  getLatest: () => string | null | Promise<string | null>;
  spawnInstall: () => void;
  loadState: () => UpdateState | null;
  saveState: (state: UpdateState) => void;
  now: () => string;
  isDevMode: () => boolean;
}

const CHECK_FAILED: SystemUpdateCheckResult = { status: 'error', reason: 'check_failed' };
const DISCOVERY_TIMEOUT_MS = 15_000;

function available(version: string): SystemUpdateCheckResult {
  return { status: 'available', update: { version } };
}

/** Bound discovery independently of consent, including an injected/stalled registry probe. */
async function boundedLatest(getLatest: ServerUpdateCoordinatorDeps['getLatest']): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(getLatest), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One instance per application: timers and the API share both discovery and prompt ownership. */
export class ServerUpdateCoordinator {
  private inFlight: Promise<SystemUpdateCheckResult> | null = null;
  private pendingVersion: string | null = null;
  private latestVersion: string | null = null;
  private promptFailed = false;
  private decision: Promise<UpdateChoice | null> = Promise.resolve(null);

  constructor(private readonly deps: ServerUpdateCoordinatorDeps) {}

  check(): Promise<SystemUpdateCheckResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.discover()
      .catch(() => CHECK_FAILED)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Compatibility for the original waiting API; runtime callers use bounded check(). */
  async checkAndWait(): Promise<{ action: UpdateChoice | null; latestVersion: string | null }> {
    await this.check();
    return { action: await this.decision, latestVersion: this.latestVersion };
  }

  private skipReason(): string | null {
    if (getSettings().serverUpdateDisable) return 'disabled';
    if (this.deps.isDevMode()) return 'dev_mode';
    const { state } = getServerUpdateStatus();
    if (state === 'installing' || state === 'restarting') return 'update_in_progress';
    return null;
  }

  private async discover(): Promise<SystemUpdateCheckResult> {
    const reason = this.skipReason();
    if (reason) return { status: 'skipped', reason };
    if (this.pendingVersion) return available(this.pendingVersion);
    return this.lookup();
  }

  private async lookup(): Promise<SystemUpdateCheckResult> {
    const version = await boundedLatest(this.deps.getLatest);
    if (!version || !/^\d+\.\d+\.\d+(?:-\d+)?$/.test(version)) return CHECK_FAILED;
    this.latestVersion = version;
    if (compareCalVer(version, CORTEX_VERSION) <= 0) return { status: 'current' };
    const state = this.deps.loadState() ?? {};
    if (state.skippedVersion === version) return { status: 'skipped', reason: 'version_skipped' };
    return this.openPrompt(version, state);
  }

  private async openPrompt(version: string, state: UpdateState): Promise<SystemUpdateCheckResult> {
    const prompted = { ...state, lastCheckedAt: this.deps.now(), lastPromptedVersion: version };
    this.deps.saveState(prompted);
    // ask() synchronously publishes the existing UI prompt before discovery can return.
    const answer = this.deps.prompt.ask({ latestVersion: version });
    this.pendingVersion = version;
    this.promptFailed = false;
    this.decision = this.handleDecision(answer, version, prompted);
    // Observe an immediately rejected prompt, without ever awaiting user consent.
    await Promise.resolve();
    return this.promptFailed ? CHECK_FAILED : available(version);
  }

  private async handleDecision(
    answer: Promise<UpdateChoice | null>, version: string, state: UpdateState,
  ): Promise<UpdateChoice | null> {
    try {
      return this.acceptChoice(await answer, version, state);
    } catch (error) {
      this.promptFailed = true;
      reportServerUpdateFailed(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      this.pendingVersion = null;
    }
  }

  private acceptChoice(choice: UpdateChoice | null, version: string, state: UpdateState): UpdateChoice | null {
    if (choice === 'apply') {
      this.deps.saveState({ ...state, skippedVersion: undefined });
      this.deps.spawnInstall();
    }
    if (choice === 'skip') this.deps.saveState({ ...state, skippedVersion: version });
    return choice;
  }
}
