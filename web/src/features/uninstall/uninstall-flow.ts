// What the uninstaller window shows, derived from the shell's answers (desktop/src-tauri/src/uninstall.rs).
import type { Vocab } from '@/i18n';
import type {
  NativeUninstallInfo, NativeUninstallStep, NativeUninstallStepName, NativeUninstallStepStatus,
} from '@/lib/native-bridge';

export type UninstallScope = 'app' | 'server';
export type ShownStatus = Exclude<NativeUninstallStepStatus, 'skipped'>;

/** The shell commands the window drives, injectable for tests. */
export interface UninstallPorts {
  info(): Promise<NativeUninstallInfo>;
  run(scope: UninstallScope, deleteData: boolean): Promise<NativeUninstallStep[]>;
  exit(proceed: boolean): Promise<unknown>;
}

export const STEP_LABEL: Record<NativeUninstallStepName, keyof Vocab> = {
  autostart: 'uninstStepAutostart', daemon: 'uninstStepDaemon', terminal: 'uninstStepTerminal',
  runtime: 'uninstStepRuntime', data: 'uninstStepData', credentials: 'uninstStepCredentials', app: 'uninstStepApp',
};

export const STATUS_LABEL: Record<ShownStatus, keyof Vocab> = {
  done: 'uninstStatusDone', failed: 'uninstStatusFailed', manual: 'uninstStatusManual', deferred: 'uninstStatusDeferred',
};

/** The onboarding status-row look each outcome borrows. */
export const STATUS_LOOK: Record<ShownStatus, 'done' | 'error' | 'warning' | 'pending'> = {
  done: 'done', failed: 'error', manual: 'warning', deferred: 'pending',
};

const REMOVAL_INTRO: Record<NativeUninstallInfo['removal'], keyof Vocab> = {
  installer: 'uninstInstallerIntro', trash: 'uninstTrashIntro', file: 'uninstRemovedIntro',
  package: 'uninstRemovedIntro', manual: 'uninstManualIntro',
};

/** Steps that did something or need the user; "nothing to do" is noise. */
export function shownSteps(steps: NativeUninstallStep[]): (NativeUninstallStep & { status: ShownStatus })[] {
  return steps.filter((s): s is NativeUninstallStep & { status: ShownStatus } => s.status !== 'skipped');
}

export type RunResult = 'done' | 'failed' | 'app-failed';

/** A server step failing stops before the app is touched; only the app failing means "delete it yourself". */
export function runResult(steps: NativeUninstallStep[]): RunResult {
  const failed = steps.filter(s => s.status === 'failed');
  if (failed.length === 0) return 'done';
  return failed.every(s => s.step === 'app') ? 'app-failed' : 'failed';
}

export function defaultScope(info: NativeUninstallInfo): UninstallScope {
  return info.localServer ? 'server' : 'app';
}

/** What "also delete data" removes for this scope: the server's home only goes with the server. */
export function dataPaths(info: NativeUninstallInfo, scope: UninstallScope): string[] {
  return [...(scope === 'server' && info.home ? [info.home] : []), ...info.appData];
}

export function dataHint(info: NativeUninstallInfo, scope: UninstallScope, deleteData: boolean): keyof Vocab {
  if (!deleteData) return 'uninstKeepDataHint';
  return scope === 'server' && info.localServer ? 'uninstDeleteServerDataHint' : 'uninstDeleteAppDataHint';
}

export function resultIntro(info: NativeUninstallInfo, result: RunResult): keyof Vocab {
  if (result === 'failed') return 'uninstFailedIntro';
  if (result === 'app-failed') return 'uninstAppFailedIntro';
  return REMOVAL_INTRO[info.removal];
}

/** Where the user finishes by hand, when they have to. */
export function manualLocation(info: NativeUninstallInfo, result: RunResult): string | null {
  const byHand = result === 'app-failed' || (result === 'done' && info.removal === 'manual');
  return byHand ? info.appLocation : null;
}
