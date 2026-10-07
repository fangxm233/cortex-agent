import type { Vocab } from '@/i18n';
import type { NativeSetupAnswers, NativeSetupProbe } from '@/lib/native-bridge';
import { parseNativeError } from '@/lib/native-error';

// POSIX setup automatically installs, initializes, starts and connects. Windows keeps its manual
// settings step; failed starts offer repair settings. Commands are owned by the native shell.

export type LocalSetupStage = 'prepare' | 'configure' | 'start' | 'ready';
export type LocalSetupStep = 'check' | 'install' | 'config' | 'daemon' | 'autostart' | 'connect';
export type LocalStepStatus = 'pending' | 'running' | 'done' | 'error' | 'warning';
interface Endpoint { url: string; token: string }

export interface LocalSetupPorts {
  probe: () => Promise<NativeSetupProbe>;
  installServer: () => Promise<{ cortexBin: string; serverVersion: string | null }>;
  cancelInstall: () => Promise<unknown>;
  runInit: (bin: string, answers: NativeSetupAnswers) => Promise<{ version: string | null; clientToken: string | null; uiUrl: string | null }>;
  enableUi: (bin: string, port?: number) => Promise<Endpoint>;
  startDaemon: (bin: string, endpoint: Endpoint) => Promise<boolean>;
  enableAutostart: () => Promise<unknown>;
  connect: (endpoint: Endpoint, cortexBin: string) => Promise<unknown>;
}

export interface LocalSetupState {
  stage: LocalSetupStage;
  busy: boolean;
  cancelling: boolean;
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
  /** Condense automatic POSIX installation and startup into one visible step. */
  automatic: boolean;
  /** Where the SPA continues once connected: provider setup after a fresh install. */
  destination: string | null;
}

export const WORKBENCH_PAGE = 'index.html';
const PROVIDER_SETUP_PAGE = 'index.html#/setup/providers';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class LocalSetupFlow {
  state: LocalSetupState = {
    stage: 'prepare', busy: false, cancelling: false, error: null, active: null, probe: null, bin: null, version: null,
    needsInit: true, endpoint: null, progress: {}, answers: null, warning: null, newInstall: null,
    destination: null, automatic: false,
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
    if (this.state.busy || this.state.cancelling) return;
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
    if (probe.os === 'windows') this.requireWindowsTools(probe);
  }

  private requireWindowsTools(probe: NativeSetupProbe) {
    if (!probe.nodeOk) throw new Error('NODE_REQUIRED');
    if (!probe.npm) throw new Error('NPM_REQUIRED');
    if (!probe.git) throw new Error('GIT_REQUIRED');
  }

  prepare = (lang?: string) => this.operation(async () => {
    this.patch({ stage: 'prepare', progress: {} });
    this.mark('check', 'running');
    this.acceptProbe(await this.ports.probe());
    this.patch({ automatic: lang !== undefined && this.state.probe?.os !== 'windows' });
    this.mark('check', 'done');
    // POSIX setup also validates and persists the selected environment for existing installs.
    if (this.state.probe?.os !== 'windows' || !this.state.probe.serverOk) {
      this.mark('install', 'running');
      const result = await this.ports.installServer();
      this.patch({ bin: result.cortexBin, version: result.serverVersion });
    }
    this.mark('install', 'done');
    if (this.state.automatic) await this.startConfigured(this.defaultAnswers(lang!));
    else this.patch({ stage: 'configure', error: null });
  });

  private defaultAnswers(lang: string): NativeSetupAnswers {
    return { lang, machineName: this.state.probe?.hostname ?? '', backends: ['pi'],
      port: 3004, installService: false, ...(!this.state.needsInit ? { preserveEndpoint: true } : {}) };
  }

  cancelInstall = async () => {
    if (!this.state.busy || this.state.cancelling) return;
    if (this.state.stage !== 'prepare' || this.state.active !== 'install') return;
    this.patch({ cancelling: true });
    try {
      await this.ports.cancelInstall();
      // The install command owns settlement: an acknowledgement is not cancellation completion.
    } catch (error) {
      if (this.state.stage === 'prepare' && this.state.busy) this.patch({ error: message(error) });
    } finally {
      this.patch({ cancelling: false });
    }
  };

  start = (answers: NativeSetupAnswers) => {
    if (this.state.stage !== 'configure' && this.state.stage !== 'start') return Promise.resolve();
    return this.operation(() => this.startConfigured(answers));
  };

  private async startConfigured(answers: NativeSetupAnswers) {
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
  }

  /** Back to the settings form after a failed start; the next start repairs instead of re-initializing. */
  configure = () => {
    if (this.state.busy || this.state.stage !== 'start' || !this.state.error) return;
    this.patch({ stage: 'configure', error: null, endpoint: null, automatic: false });
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
      endpoint = await this.ports.enableUi(bin, answers.preserveEndpoint ? undefined : answers.port);
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
  RUNTIME_DOWNLOAD_FAILED: 'onbErrRuntimeDownloadFailed', RUNTIME_INTEGRITY_FAILED: 'onbErrRuntimeIntegrityFailed',
  RUNTIME_UNSUPPORTED: 'onbErrRuntimeUnsupported', RUNTIME_MISSING: 'onbErrRuntimeMissing',
  SERVER_EXTERNAL_UNSUPPORTED: 'onbErrServerExternalUnsupported', SETUP_CANCELLED: 'onbErrSetupCancelled',
};

/** Show only the actionable sentence; native details belong in the folded activity log. */
export function localSetupErrorText(error: string, L: Vocab): string {
  const parts = parseNativeError(error);
  if (!parts || !Object.hasOwn(ERROR_KEYS, parts.code)) return L.onbErrSetupTaskFailed;
  return L[ERROR_KEYS[parts.code]!];
}

/** One `setup-log` line of the install/start runs, without terminal colour codes. */
export function setupLogLine(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const run: unknown = Reflect.get(payload, 'run');
  if (run !== 'install' && run !== 'start') return null;
  const line: unknown = Reflect.get(payload, 'line');
  return String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}
