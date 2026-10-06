import type { Vocab } from '@/i18n';
import type { NativeSetupAnswers, NativeSetupProbe } from '@/lib/native-bridge';
import { parseNativeError } from '@/lib/native-error';

// The local install, as the native shell drives it: check this computer, install the server, then
// (after the user confirms the settings) initialize or repair it, start the daemon, optionally
// enable auto-start, and connect. Every step is a native command (desktop/src-tauri/src/setup.rs).

export type LocalSetupStage = 'prepare' | 'configure' | 'start' | 'ready';
export type LocalSetupStep = 'check' | 'install' | 'config' | 'daemon' | 'autostart' | 'connect';
export type LocalStepStatus = 'pending' | 'running' | 'done' | 'error' | 'warning';
interface Endpoint { url: string; token: string }

export interface LocalSetupPorts {
  probe: () => Promise<NativeSetupProbe>;
  installServer: () => Promise<{ cortexBin: string; serverVersion: string | null }>;
  runInit: (bin: string, answers: NativeSetupAnswers) => Promise<{ version: string | null; clientToken: string | null; uiUrl: string | null }>;
  enableUi: (bin: string, port: number) => Promise<Endpoint>;
  startDaemon: (bin: string, endpoint: Endpoint) => Promise<boolean>;
  enableAutostart: () => Promise<unknown>;
  connect: (endpoint: Endpoint, cortexBin: string) => Promise<unknown>;
}

export interface LocalSetupState {
  stage: LocalSetupStage;
  busy: boolean;
  error: string | null;
  active: LocalSetupStep | null;
  probe: NativeSetupProbe | null;
  bin: string | null;
  version: string | null;
  needsInit: boolean;
  endpoint: Endpoint | null;
  progress: Partial<Record<LocalSetupStep, LocalStepStatus>>;
  answers: NativeSetupAnswers | null;
  warning: 'AUTOSTART_FAILED' | null;
  newInstall: boolean | null;
  /** Where the SPA continues once connected: provider setup after a fresh install. */
  destination: string | null;
}

export const WORKBENCH_PAGE = 'index.html';
const PROVIDER_SETUP_PAGE = 'index.html#/setup/providers';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class LocalSetupFlow {
  state: LocalSetupState = {
    stage: 'prepare', busy: false, error: null, active: null, probe: null, bin: null, version: null,
    needsInit: true, endpoint: null, progress: {}, answers: null, warning: null, newInstall: null,
    destination: null,
  };
  private listeners = new Set<() => void>();
  /** `ready` resolves once the activity-log listener is registered, before the first command. */
  constructor(private ports: LocalSetupPorts, private ready: Promise<unknown> = Promise.resolve()) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private patch(patch: Partial<LocalSetupState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private mark(step: LocalSetupStep, status: LocalStepStatus) {
    this.patch({ progress: { ...this.state.progress, [step]: status }, active: step });
  }

  private async operation(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.patch({ busy: true, error: null });
    try {
      await this.ready;
      await action();
    } catch (error) {
      const progress = this.state.active ? { ...this.state.progress, [this.state.active]: 'error' as const } : this.state.progress;
      this.patch({ error: message(error), progress });
    } finally {
      this.patch({ busy: false });
    }
  }

  private acceptProbe(probe: NativeSetupProbe) {
    const needsInit = !probe.homeExists;
    // Keep the entry identity even after init creates config or a retry re-probes.
    this.patch({ probe, bin: probe.cortexBin, version: probe.serverVersion, needsInit,
      newInstall: this.state.newInstall ?? needsInit });
    if (!probe.nodeOk) throw new Error('NODE_REQUIRED');
    if (!probe.npm) throw new Error('NPM_REQUIRED');
    if (probe.os === 'windows' && !probe.git) throw new Error('GIT_REQUIRED');
  }

  prepare = () => this.operation(async () => {
    this.patch({ stage: 'prepare', progress: {} });
    this.mark('check', 'running');
    this.acceptProbe(await this.ports.probe());
    this.mark('check', 'done');
    if (!this.state.probe?.serverOk) {
      this.mark('install', 'running');
      const result = await this.ports.installServer();
      this.patch({ bin: result.cortexBin, version: result.serverVersion });
    }
    this.mark('install', 'done');
    this.patch({ stage: 'configure' });
  });

  start = (answers: NativeSetupAnswers) => this.operation(async () => {
    this.patch({ stage: 'start', progress: {}, answers });
    const endpoint = await this.initialize(answers);
    const bin = this.state.bin ?? '';
    this.mark('daemon', 'running');
    if (!await this.ports.startDaemon(bin, endpoint)) throw new Error('DAEMON_TIMEOUT');
    this.mark('daemon', 'done');
    if (answers.installService) await this.autostart();
    this.mark('connect', 'running');
    await this.ports.connect(endpoint, bin);
    this.mark('connect', 'done');
    this.patch({ stage: 'ready', destination: this.state.newInstall ? PROVIDER_SETUP_PAGE : WORKBENCH_PAGE });
  });

  /** Back to the settings form after a failed start; the next start repairs instead of re-initializing. */
  configure = () => {
    if (this.state.busy) return;
    this.patch({ stage: 'configure', error: null, endpoint: null });
  };

  private async initialize(answers: NativeSetupAnswers): Promise<Endpoint> {
    if (this.state.endpoint) { this.mark('config', 'done'); return this.state.endpoint; }
    this.mark('config', 'running');
    const bin = this.state.bin ?? '';
    let endpoint: Endpoint;
    if (this.state.needsInit) {
      const result = await this.ports.runInit(bin, answers);
      if (!result.uiUrl || !result.clientToken) throw new Error('INIT_ENDPOINT_MISSING');
      endpoint = { url: result.uiUrl, token: result.clientToken };
      this.patch({ version: result.version || this.state.version });
    } else {
      endpoint = await this.ports.enableUi(bin, answers.port);
    }
    this.patch({ endpoint, needsInit: false });
    this.mark('config', 'done');
    return endpoint;
  }

  private async autostart() {
    this.mark('autostart', 'running');
    try {
      await this.ports.enableAutostart();
      this.mark('autostart', 'done');
    } catch {
      this.patch({ warning: 'AUTOSTART_FAILED' });
      this.mark('autostart', 'warning');
    }
  }
}

// Codes the flow raises itself and the native setup commands return, as `CODE` or `CODE: detail`.
const ERROR_KEYS: Record<string, keyof Vocab> = {
  NODE_REQUIRED: 'onbErrNodeRequired', NPM_REQUIRED: 'onbErrNpmRequired', GIT_REQUIRED: 'onbErrGitRequired',
  EACCES: 'onbErrEacces', DAEMON_TIMEOUT: 'onbErrDaemonTimeout', INIT_ENDPOINT_MISSING: 'onbErrInitEndpointMissing',
  SERVER_INSTALL_FAILED: 'onbErrServerInstallFailed', SERVER_PACKAGE_INVALID: 'onbErrServerPackageInvalid',
  SERVER_TOO_OLD: 'onbErrServerTooOld', CLI_NOT_ON_PATH: 'onbErrCliNotOnPath',
  ANSWERS_FILE_FAILED: 'onbErrAnswersFileFailed', INIT_FAILED: 'onbErrInitFailed', INIT_NO_RESULT: 'onbErrInitNoResult',
  UI_ENABLE_FAILED: 'onbErrUiEnableFailed', DAEMON_START_FAILED: 'onbErrDaemonStartFailed',
  PROGRAM_FAILED: 'onbErrProgramFailed', SETUP_TASK_FAILED: 'onbErrSetupTaskFailed',
};

/** A known code as its sentence with the detail (often raw process output) under it; anything else as it came. */
export function localSetupErrorText(error: string, L: Vocab): string {
  const parts = parseNativeError(error);
  if (!parts || !Object.hasOwn(ERROR_KEYS, parts.code)) return error;
  const sentence = L[ERROR_KEYS[parts.code]!];
  return parts.detail ? `${sentence}\n\n${parts.detail}` : sentence;
}

/** One `setup-log` line of the install/start runs, without terminal colour codes. */
export function setupLogLine(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const run: unknown = Reflect.get(payload, 'run');
  if (run !== 'install' && run !== 'start') return null;
  const line: unknown = Reflect.get(payload, 'line');
  return String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
