// input:  trial root, Node entry, allowlisted parent runtime env
// output: pinned trial paths, exact child env, launch spec, child process
// pos:    Fresh-process boundary for benchmark Node entries
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_RUNTIME_PATH = [
  path.dirname(process.execPath),
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
].filter((value, index, values) => values.indexOf(value) === index).join(path.delimiter);

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
  passthroughEnv?: string[];
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

const INHERITED_ENV_KEYS = new Set(['LANG', 'TZ', 'TERM', 'NODE_ENV']);
const NEVER_INHERIT = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS']);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isInheritedRuntimeKey(key: string): boolean {
  return INHERITED_ENV_KEYS.has(key) || key.startsWith('LC_');
}

function splitPathValues(part: string): string[] {
  const token = part.includes('=') ? part.slice(part.lastIndexOf('=') + 1) : part;
  if (token.includes('://')) return [token];
  return token.split(path.delimiter);
}

function tokenPath(token: string, cwd: string): string | null {
  const unquoted = token.replace(/^["']|["']$/g, '');
  if (unquoted.startsWith('file://')) {
    try { return fileURLToPath(unquoted); }
    catch { return null; }
  }
  if (!unquoted.includes('/') || unquoted.includes('://')) return null;
  return path.isAbsolute(unquoted) ? path.resolve(unquoted) : path.resolve(cwd, unquoted);
}

function pathCandidates(value: string, cwd: string): string[] {
  return value.split(/[\s,;]+/).flatMap(splitPathValues)
    .map(token => tokenPath(token, cwd)).filter((item): item is string => item !== null);
}

function physicalPath(value: string, depth = 0): string {
  const absolute = path.resolve(value);
  if (depth >= 40) return absolute;
  let cursor = absolute;
  const suffix: string[] = [];
  while (true) {
    try { return path.join(fs.realpathSync(cursor), ...suffix); }
    catch {}
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        const target = fs.readlinkSync(cursor);
        const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(cursor), target);
        return physicalPath(path.join(resolved, ...suffix), depth + 1);
      }
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function referencesForbiddenRoot(
  value: string, cwd: string, paths: PinnedTrialPaths, parentEnv: NodeJS.ProcessEnv,
): boolean {
  const roots = [os.homedir(), parentEnv.CORTEX_HOME].filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
  const trialRoot = physicalPath(paths.root);
  return pathCandidates(value, cwd).some((candidate) => {
    const physical = physicalPath(candidate);
    return !isWithin(physical, trialRoot)
      && roots.some(root => isWithin(physical, physicalPath(root)));
  });
}

function assertPassthrough(
  key: string, value: string, cwd: string,
  paths: PinnedTrialPaths, parentEnv: NodeJS.ProcessEnv,
): void {
  if (!ENV_KEY.test(key)) throw new Error(`Invalid passthrough environment key: ${key}`);
  if (PINNED_ENV_KEYS.includes(key as typeof PINNED_ENV_KEYS[number])) {
    throw new Error(`Cannot passthrough pinned environment key: ${key}`);
  }
  if (NEVER_INHERIT.has(key) || key.startsWith('NODE_REPL_')) {
    throw new Error(`Unsafe Node environment key cannot be inherited: ${key}`);
  }
  if (referencesForbiddenRoot(value, cwd, paths, parentEnv)) {
    throw new Error(`Passthrough ${key} references a forbidden host root`);
  }
}

function passthroughEnvironment(
  names: string[], parentEnv: NodeJS.ProcessEnv, paths: PinnedTrialPaths, cwd: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = parentEnv[name];
    if (value === undefined) continue;
    assertPassthrough(name, value, cwd, paths, parentEnv);
    result[name] = value;
  }
  return result;
}

function inheritedEnvironment(
  parentEnv: NodeJS.ProcessEnv, paths: PinnedTrialPaths, passthrough: string[], cwd: string,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(parentEnv).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && isInheritedRuntimeKey(entry[0]),
  ));
  return {
    ...inherited,
    ...passthroughEnvironment(passthrough, parentEnv, paths, cwd),
    PATH: PINNED_RUNTIME_PATH,
  };
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
  const cwd = resolveDirectory(options.workspaceCwd, 'workspaceCwd');
  return {
    command: process.execPath,
    args: [
      '--no-global-search-paths',
      ...(options.nodeArgs ?? []),
      path.resolve(options.entry),
      ...(options.args ?? []),
    ],
    cwd,
    env: {
      ...inheritedEnvironment(parentEnv, paths, options.passthroughEnv ?? [], cwd),
      ...pinnedEnvironment(paths),
    },
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
