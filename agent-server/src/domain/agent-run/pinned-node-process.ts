// input:  trial root, Node entry, allowlisted parent runtime env
// output: pinned trial paths, exact child env, launch spec, child process
// pos:    Fresh-process boundary for benchmark Node entries
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PINNED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CORTEX_HOME',
  'CORTEX_PROJECTS_DIR',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
] as const;

export interface PinnedTrialPaths {
  root: string;
  home: string;
  cortexHome: string;
  projectsDir: string;
  xdgConfigHome: string;
  xdgCacheHome: string;
  claudeConfigDir: string;
  tempDir: string;
  logsDir: string;
}

export interface PinnedNodeLaunchOptions {
  trialRoot: string;
  workspaceCwd: string;
  entry: string;
  args?: string[];
  nodeArgs?: string[];
  parentEnv?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

export interface PinnedNodeLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
  paths: PinnedTrialPaths;
}

function isInheritedRuntimeKey(key: string): boolean {
  return key === 'PATH'
    || key === 'LANG'
    || key === 'LANGUAGE'
    || key === 'TZ'
    || key.startsWith('LC_')
    || key.startsWith('NODE_');
}

function inheritedEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parentEnv).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && isInheritedRuntimeKey(entry[0]),
  ));
}

function pinnedEnvironment(paths: PinnedTrialPaths): NodeJS.ProcessEnv {
  return {
    HOME: paths.home,
    CORTEX_HOME: paths.cortexHome,
    CORTEX_PROJECTS_DIR: paths.projectsDir,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    TMPDIR: paths.tempDir,
    TMP: paths.tempDir,
    TEMP: paths.tempDir,
  };
}

function assertEmptyProjectsDir(projectsDir: string): void {
  if (fs.existsSync(projectsDir) && fs.readdirSync(projectsDir).length > 0) {
    throw new Error(`CORTEX_PROJECTS_DIR must be empty: ${projectsDir}`);
  }
  fs.mkdirSync(projectsDir, { recursive: true });
}

export function preparePinnedTrialPaths(trialRoot: string): PinnedTrialPaths {
  const root = path.resolve(trialRoot);
  const paths = {
    root,
    home: path.join(root, 'home'),
    cortexHome: path.join(root, 'cortex-home'),
    projectsDir: path.join(root, 'projects'),
    xdgConfigHome: path.join(root, 'xdg-config'),
    xdgCacheHome: path.join(root, 'xdg-cache'),
    claudeConfigDir: path.join(root, 'claude-config'),
    tempDir: path.join(root, 'tmp'),
    logsDir: path.join(root, 'logs'),
  };
  fs.mkdirSync(root, { recursive: true });
  assertEmptyProjectsDir(paths.projectsDir);
  for (const value of Object.values(paths).slice(1)) fs.mkdirSync(value, { recursive: true });
  return paths;
}

function resolveDirectory(directory: string, label: string): string {
  try {
    const resolved = fs.realpathSync(directory);
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {}
  throw new Error(`${label} must be an existing directory: ${directory}`);
}

export function preparePinnedNodeLaunch(options: PinnedNodeLaunchOptions): PinnedNodeLaunchSpec {
  const paths = preparePinnedTrialPaths(options.trialRoot);
  const parentEnv = options.parentEnv ?? process.env;
  return {
    command: process.execPath,
    args: [
      '--no-global-search-paths',
      ...(options.nodeArgs ?? []),
      path.resolve(options.entry),
      ...(options.args ?? []),
    ],
    cwd: resolveDirectory(options.workspaceCwd, 'workspaceCwd'),
    env: { ...inheritedEnvironment(parentEnv), ...pinnedEnvironment(paths) },
    stdio: options.stdio ?? 'inherit',
    paths,
  };
}

export function spawnPinnedNode(options: PinnedNodeLaunchOptions): ChildProcess {
  const launch = preparePinnedNodeLaunch(options);
  return spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: launch.stdio,
    shell: false,
  });
}
