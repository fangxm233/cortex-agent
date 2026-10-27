import { spawn } from 'node:child_process';
import {
  finishRebuildStep, startRebuildStep, type RebuildProgress, type RebuildStepName,
} from '@core/rebuild-progress.js';

export interface RebuildStep {
  label: RebuildStepName;
  cmd: string;
  args: string[];
  cwd: string;
}

export interface RebuildDirs {
  repoDir: string;
  uiContractDir?: string | null;
  webDir?: string | null;
}

export interface RebuildLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type RebuildCommand = (
  cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<number>;

export interface RebuildBuildOptions {
  dirs: RebuildDirs;
  log: RebuildLog;
  run: RebuildCommand;
  update(patch: (progress: RebuildProgress) => RebuildProgress): void;
  abort(step: string, detail: string): void;
}

/** Stream subprocess output through the daemon logger; preserve the parent runtime environment. */
export function spawnRebuildCommand(
  cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }, log: RebuildLog,
): Promise<number> {
  return new Promise((resolve) => {
    const tag = `[${cmd} ${args.join(' ')}]`;
    log.info(`${tag} cwd=${opts.cwd}`);
    const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout?.on('data', logCommandLines(log, tag, 'out'));
    proc.stderr?.on('data', logCommandLines(log, tag, 'err'));
    proc.on('exit', (code) => {
      log.info(`${tag} exit=${code}`);
      resolve(code ?? 1);
    });
    proc.on('error', (err) => {
      log.error(`${tag} spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

function logCommandLines(log: RebuildLog, tag: string, label: string): (chunk: Buffer) => void {
  return (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) log.info(`${tag} ${label}: ${line}`);
    }
  };
}

/** Server types → ui-contract → web typecheck is ordered; web bundle and depcruise run beside it. */
export function planRebuildLanes(dirs: RebuildDirs): RebuildStep[][] {
  const run = (label: RebuildStepName, cwd: string, script: string): RebuildStep => (
    { label, cmd: 'npm', args: ['run', script], cwd }
  );
  const types = [run('server', dirs.repoDir, 'build')];
  if (dirs.uiContractDir) types.push(run('ui-contract', dirs.uiContractDir, 'build'));
  if (!dirs.webDir) return [types];
  types.push(run('web-typecheck', dirs.webDir, 'typecheck'));
  return [types, [run('web-bundle', dirs.webDir, 'bundle')], [run('web-depcruise', dirs.webDir, 'depcruise')]];
}

/** Staging runs before the second idle gate and never holds turns. */
export function planRebuildStepNames(dirs: RebuildDirs, bundle = true): RebuildStepName[] {
  const names = planRebuildLanes(dirs).flat().map((step) => step.label);
  if (bundle) names.push('bundle');
  return [...names, 'install', 'restart'];
}

async function runBuildLane(
  lane: RebuildStep[], options: RebuildBuildOptions,
): Promise<{ label: string; detail: string } | null> {
  for (const step of lane) {
    options.update((progress) => startRebuildStep(progress, step.label));
    const code = await options.run(step.cmd, step.args, { cwd: step.cwd });
    if (code !== 0) {
      const detail = `exit ${code}`;
      options.update((progress) => finishRebuildStep(progress, step.label, 'failed', detail));
      return { label: step.label, detail };
    }
    options.update((progress) => finishRebuildStep(progress, step.label, 'done'));
  }
  return null;
}

/** Wait for every lane even on failure, so the abort names all failed steps. */
export async function runBuildSteps(options: RebuildBuildOptions): Promise<boolean> {
  const lanes = planRebuildLanes(options.dirs);
  if (!lanes.flat().some((step) => step.label === 'web-bundle')) {
    options.log.warn('WEB_DIR not found — skipping web build, pack will use stale web/dist if present');
  }
  const failures = (await Promise.all(lanes.map(lane => runBuildLane(lane, options))))
    .filter((failure) => failure !== null);
  if (failures.length === 0) return true;
  options.abort(failures.map(f => f.label).join(', '), failures.map(f => f.detail).join(', '));
  return false;
}
