// Client hot-reload — two modes:
//   Dev mode  (CORTEX_REPO set):    build client from source, check tgz mtime,
//                                   SCP to remotes + npm install -g + restart.
//   Release mode (CORTEX_REPO unset): check npm registry vs installed version,
//                                   npm update -g + restart. Covers remote devices
//                                   (over SSH) AND the local same-machine client
//                                   (local npm + process.kill + detached respawn).
import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFile, execFileSync, spawn } from 'child_process';
import { getMachineRegistry, type MachineEntry } from '../tasks/dispatch-utils.js';
import { sshExec, clientPids, buildRemoteSpawnCommand, buildRemoteInstallCommand } from './client-manager.js';
import { STORE_DIR, withNpmPrefix } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('client-hot-reload');

const VERSION_FILE = path.join(STORE_DIR, 'client-version.json');

// --- Types ---

interface DeviceResult {
  device: string;
  updated: boolean;
  restarted: boolean;
  oldVersion?: string;
  newVersion?: string;
  error?: string;
}

interface ClientUpdateResult {
  mode: 'dev' | 'release';
  oldVersion: string | null;
  newVersion: string;
  devices: DeviceResult[];
  duration: number;
}

interface StoredState {
  mode: 'dev' | 'release';
  dev?: { mtime: number; tgzPath: string };
  release?: { version: string };
  updatedAt: string;
}

// --- Mode detection ---

function isDevMode(): boolean {
  const repo = process.env.CORTEX_REPO;
  if (!repo) return false;
  try {
    return fs.existsSync(repo) && fs.statSync(repo).isDirectory();
  } catch {
    return false;
  }
}

function resolveClientRepo(): string | null {
  // Explicit override
  if (process.env.CORTEX_CLIENT_REPO) {
    const p = process.env.CORTEX_CLIENT_REPO;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch {}
  }

  // Derive from CORTEX_REPO (sibling directory)
  const repo = process.env.CORTEX_REPO;
  if (!repo) return null;
  const clientPath = path.resolve(repo, '..', 'client');
  try {
    if (fs.existsSync(clientPath) && fs.statSync(clientPath).isDirectory()) return clientPath;
  } catch {}
  return null;
}

// --- Version state persistence ---

function loadStoredState(): StoredState | null {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveDevState(mtime: number, tgzPath: string): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    mode: 'dev' as const,
    dev: { mtime, tgzPath },
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function saveReleaseState(version: string): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    mode: 'release' as const,
    release: { version },
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

// --- Dev mode: client build ---

function buildClient(repoPath: string): { tgzPath: string; mtime: number } | null {
  try {
    log.info(`Building client in ${repoPath}...`);

    // Step 1: build
    const buildStart = Date.now();
    execSync('npm run build', { cwd: repoPath, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
    log.info(`  build: ${Date.now() - buildStart}ms`);

    // Step 2: clean old tgz
    try {
      const oldTgzs = fs.readdirSync(repoPath).filter(f =>
        f.startsWith('cortex-agent-client-') && f.endsWith('.tgz')
      );
      for (const f of oldTgzs) {
        fs.unlinkSync(path.join(repoPath, f));
      }
    } catch {}

    // Step 3: pack
    const packStart = Date.now();
    execSync('npm pack', { cwd: repoPath, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
    log.info(`  pack: ${Date.now() - packStart}ms`);

    // Step 4: find the produced tgz
    const candidates = fs.readdirSync(repoPath)
      .filter(f => f.startsWith('cortex-agent-client-') && f.endsWith('.tgz'))
      .map(f => ({ f, mtime: fs.statSync(path.join(repoPath, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length === 0) {
      log.error('Build succeeded but no cortex-agent-client-*.tgz found');
      return null;
    }

    const tgzPath = path.join(repoPath, candidates[0].f);
    log.info(`Client built: ${candidates[0].f} (mtime=${candidates[0].mtime})`);
    return { tgzPath, mtime: candidates[0].mtime };
  } catch (err) {
    log.error(`Client build failed: ${(err as Error).message}`);
    return null;
  }
}

// --- Dev mode: SCP to remote ---

function scpToRemote(host: string, localPath: string, remotePath: string, timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('scp', [
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=no',
      localPath,
      `${host}:${remotePath}`,
    ], { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`SCP error: ${err.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

// --- Release mode: npm global prefix resolution ---

const CLIENT_PKG = '@cortex-agent/client';

/**
 * The client is installed as the `cortex-client` binary — resolve the npm global
 * prefix from it (see resolveNpmGlobalPrefix), so the version probe and the update
 * both act on the root the client actually lives in rather than npm's default.
 */
function clientNpmArgs(args: string[]): string[] {
  return withNpmPrefix(args, 'cortex-client');
}

/**
 * Remote counterpart of resolveNpmGlobalPrefix: same derivation, done in the
 * remote shell (the prefix is a property of the remote host, not of this one).
 * Windows hosts keep the plain command — npm there installs into the roaming
 * prefix owned by the user, so EACCES is not a failure mode.
 */
function buildRemoteNpmUpdateCommand(reg: MachineEntry): string {
  const plain = `npm update -g ${CLIENT_PKG} 2>&1`;
  if (reg.win) return plain;
  return [
    'b="$(command -v cortex-client 2>/dev/null)"; p=""',
    '[ -n "$b" ] && p="$(dirname "$(dirname "$b")")"',
    `if [ -n "$p" ] && [ -d "$p/lib/node_modules" ]; then npm update -g --prefix "$p" ${CLIENT_PKG} 2>&1; else ${plain}; fi`,
  ].join('; ');
}

// --- Release mode: npm registry helpers ---

function getNpmRegistryVersion(): string | null {
  try {
    const result = execSync('npm view @cortex-agent/client version 2>/dev/null || true', {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function getLocalInstalledVersion(): string | null {
  // Must use the same prefix as the update below, or the probe reads a different
  // (empty) global root and reports the client as missing on every check.
  let out = '';
  try {
    out = execFileSync('npm', clientNpmArgs(['ls', '-g', CLIENT_PKG, '--json']), {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    }).trim();
  } catch (err) {
    // `npm ls` exits non-zero when the package is absent, but still prints JSON.
    out = String((err as { stdout?: unknown })?.stdout ?? '').trim();
  }
  try {
    return JSON.parse(out)?.dependencies?.[CLIENT_PKG]?.version || null;
  } catch {
    return null;
  }
}

function npmUpdateLocal(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('npm', clientNpmArgs(['update', '-g', CLIENT_PKG]), { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`npm update error: ${err.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

async function getRemoteInstalledVersion(reg: MachineEntry): Promise<string | null> {
  const host = reg.ssh!;
  try {
    // Same prefix caveat as the local probe: read the root the client is installed in.
    const cmd = reg.win
      ? `npm ls -g ${CLIENT_PKG} --json 2>/dev/null || true`
      : [
          'b="$(command -v cortex-client 2>/dev/null)"; p=""',
          '[ -n "$b" ] && p="$(dirname "$(dirname "$b")")"',
          `if [ -n "$p" ] && [ -d "$p/lib/node_modules" ]; then npm ls -g --prefix "$p" ${CLIENT_PKG} --json 2>/dev/null || true; else npm ls -g ${CLIENT_PKG} --json 2>/dev/null || true; fi`,
        ].join('; ');
    const result = await sshExec(host, cmd, 15000);
    try {
      const parsed = JSON.parse(result);
      return parsed?.dependencies?.['@cortex-agent/client']?.version || null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// --- Per-device operations ---

async function killClientOnDevice(device: string, reg: MachineEntry): Promise<boolean> {
  const pid = clientPids.get(device);
  if (!pid) return false;

  try {
    if (!reg.ssh) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    } else if (reg.win) {
      await sshExec(reg.ssh, `taskkill /pid ${pid} /f /t 2>nul || echo ok`, 10000);
    } else {
      await sshExec(reg.ssh, `kill ${pid} 2>/dev/null || true`, 10000);
    }
    clientPids.delete(device);
    return true;
  } catch {
    return false;
  }
}

async function restartClientOnDevice(device: string, reg: MachineEntry): Promise<boolean> {
  try {
    if (!reg.ssh) {
      // Local device: spawn a detached cortex-client (mirrors client-manager
      // startRemoteClient local branch). PATH now resolves to the just-updated
      // global binary. Env (incl. CORTEX_CLIENT_TOKEN) is inherited from the server.
      const child = spawn('cortex-client', [], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        log.warn(`Local client respawn error on ${device}: ${(err as Error).message}`);
      });
      child.unref();
      if (child.pid) {
        clientPids.set(device, child.pid);
        log.info(`Restarted local client on ${device} (PID ${child.pid})`);
        return true;
      }
      return false;
    }
    if (reg.win) {
      const wmiArg = 'cmd.exe /c cortex-client';
      await sshExec(reg.ssh,
        `powershell -Command "(Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList '${wmiArg}').ProcessId"`,
        30000
      );
    } else {
      await sshExec(reg.ssh, buildRemoteSpawnCommand(reg), 30000);
    }
    return true;
  } catch (err) {
    log.warn(`Failed to restart client on ${device}: ${(err as Error).message}`);
    return false;
  }
}

// --- Dev mode: full per-device update ---

async function updateClientDev(
  device: string,
  reg: MachineEntry,
  tgzPath: string,
  tgzName: string,
): Promise<DeviceResult> {
  const res: DeviceResult = { device, updated: false, restarted: false };

  if (!reg.ssh) {
    res.error = 'Local client dev-update not supported (use npm install -g with tgz manually)';
    return res;
  }

  try {
    // 1. Kill existing client
    await killClientOnDevice(device, reg);

    // 2. SCP tgz to remote
    const remoteTmpPath = `/tmp/${tgzName}`;
    log.info(`  ${device}: SCP ${tgzName} → ${reg.ssh}:/tmp/`);
    await scpToRemote(reg.ssh, tgzPath, remoteTmpPath, 60000);

    // 3. Install from tgz (command configurable per machine — machines.json `installCommand`,
    //    e.g. wrap in a login/interactive shell on nvm hosts where npm is off the SSH PATH)
    const installCmd = `${buildRemoteInstallCommand(reg, remoteTmpPath)} 2>&1`;
    const installOutput = await sshExec(reg.ssh, installCmd, 60000);
    log.info(`  ${device}: npm install -g output: ${installOutput.slice(0, 200)}`);
    res.updated = true;

    // 4. Clean up remote tgz
    try {
      await sshExec(reg.ssh, `rm -f ${remoteTmpPath}`, 10000);
    } catch {}

    // 5. Restart client
    res.restarted = await restartClientOnDevice(device, reg);
  } catch (err) {
    res.error = (err as Error).message;
    log.warn(`  ${device}: dev update failed — ${res.error}`);
  }

  return res;
}

// --- Release mode: local (same-machine) update ---

// Injectable operations so the local-update flow is unit-testable without
// touching npm / processes.
interface LocalUpdateDeps {
  getInstalledVersion: () => string | null;
  kill: () => Promise<boolean>;
  npmUpdate: () => Promise<string>;
  restart: () => Promise<boolean>;
}

async function updateClientReleaseLocal(
  device: string,
  latestVersion: string,
  deps: LocalUpdateDeps,
): Promise<DeviceResult> {
  const res: DeviceResult = { device, updated: false, restarted: false, oldVersion: '?', newVersion: latestVersion };

  try {
    const localVer = deps.getInstalledVersion();
    res.oldVersion = localVer || '?';

    if (localVer === latestVersion) {
      log.info(`  ${device}: already at latest (${latestVersion})`);
      return res;
    }

    // 1. Kill the running local client (frees the device name for reconnect)
    await deps.kill();

    // 2. npm update -g locally
    const updateOutput = await deps.npmUpdate();
    res.updated = true;
    log.info(`  ${device}: local npm update output: ${updateOutput.slice(0, 200)}`);

    // 3. Respawn the local client on the new binary
    res.restarted = await deps.restart();
  } catch (err) {
    res.error = (err as Error).message;
    log.warn(`  ${device}: local release update failed — ${res.error}`);
    // The client was already killed. A failed update must not leave the device
    // offline — bring it back up on the old binary.
    try {
      res.restarted = await deps.restart();
    } catch {}
  }

  return res;
}

// --- Release mode: full per-device update ---

async function updateClientRelease(
  device: string,
  reg: MachineEntry,
  latestVersion: string,
): Promise<DeviceResult> {
  const res: DeviceResult = { device, updated: false, restarted: false, oldVersion: '?', newVersion: latestVersion };

  if (!reg.ssh) {
    // Local same-machine client: update via local npm + process.kill + detached respawn.
    return updateClientReleaseLocal(device, latestVersion, {
      getInstalledVersion: getLocalInstalledVersion,
      kill: () => killClientOnDevice(device, reg),
      npmUpdate: npmUpdateLocal,
      restart: () => restartClientOnDevice(device, reg),
    });
  }

  try {
    // 1. Check remote installed version
    const remoteVer = await getRemoteInstalledVersion(reg);
    res.oldVersion = remoteVer || '?';

    if (remoteVer === latestVersion) {
      log.info(`  ${device}: already at latest (${latestVersion})`);
      return res;
    }

    // 2. Kill existing client
    await killClientOnDevice(device, reg);

    // 3. npm update (prefix resolved in the remote shell — see buildRemoteNpmUpdateCommand)
    const updateOutput = await sshExec(reg.ssh, buildRemoteNpmUpdateCommand(reg), 60000);
    res.updated = true;
    log.info(`  ${device}: npm update output: ${updateOutput.slice(0, 200)}`);

    // 4. Restart client
    res.restarted = await restartClientOnDevice(device, reg);
  } catch (err) {
    res.error = (err as Error).message;
    log.warn(`  ${device}: release update failed — ${res.error}`);
  }

  return res;
}

// --- Main check-and-update ---

async function checkAndUpdateClients(): Promise<ClientUpdateResult | null> {
  const dev = isDevMode();
  const stored = loadStoredState();
  const start = Date.now();

  if (dev) {
    return checkAndUpdateDev(stored, start);
  } else {
    return checkAndUpdateRelease(stored, start);
  }
}

async function checkAndUpdateDev(stored: StoredState | null, start: number): Promise<ClientUpdateResult | null> {
  const clientRepo = resolveClientRepo();
  if (!clientRepo) {
    log.warn('Dev mode: CORTEX_REPO is set but client repo not found — skipping update');
    return null;
  }

  // Build client from source
  const built = buildClient(clientRepo);
  if (!built) {
    log.error('Dev mode: client build failed — skipping update');
    return null;
  }

  const tgzName = path.basename(built.tgzPath);

  // First run or mode change: save state, skip update
  if (!stored || stored.mode !== 'dev') {
    const label = !stored ? 'First run' : 'Mode changed to dev';
    log.info(`Dev mode — ${label}: saving client mtime=${built.mtime}, skipping update`);
    saveDevState(built.mtime, built.tgzPath);
    return null;
  }

  // Compare mtime
  const oldMtime = stored.dev?.mtime ?? 0;
  if (built.mtime === oldMtime) {
    log.info(`Dev mode: client tgz mtime unchanged (${built.mtime}) — skipping update`);
    return null;
  }

  log.info(`Dev mode: client tgz changed — mtime ${oldMtime} → ${built.mtime}`);

  const registry = getMachineRegistry();
  const devices = await Promise.all(
    Object.entries(registry).map(async ([device, reg]): Promise<DeviceResult> => {
      return updateClientDev(device, reg, built.tgzPath, tgzName);
    })
  );

  const duration = Date.now() - start;
  saveDevState(built.mtime, built.tgzPath);

  for (const d of devices) {
    const status = d.updated && d.restarted ? 'OK' : (d.error ? 'FAIL' : 'SKIP');
    log.info(`  ${d.device}: ${status}${d.error ? ` (${d.error})` : ''}`);
  }

  return {
    mode: 'dev',
    oldVersion: String(oldMtime),
    newVersion: String(built.mtime),
    devices,
    duration,
  };
}

async function checkAndUpdateRelease(stored: StoredState | null, start: number): Promise<ClientUpdateResult | null> {
  // Get latest version from npm registry
  const latestVersion = getNpmRegistryVersion();
  if (!latestVersion) {
    log.warn('Release mode: could not fetch latest version from npm registry — skipping update');
    return null;
  }

  // First run or mode change: save state, skip update
  if (!stored || stored.mode !== 'release') {
    const label = !stored ? 'First run' : 'Mode changed to release';
    log.info(`Release mode — ${label}: saving version ${latestVersion}, skipping update`);
    saveReleaseState(latestVersion);
    return null;
  }

  // Compare versions
  const oldVersion = stored.release?.version ?? '?';
  if (oldVersion === latestVersion) {
    log.info(`Release mode: version unchanged (${latestVersion}) — skipping update`);
    return null;
  }

  log.info(`Release mode: new version available — ${oldVersion} → ${latestVersion}`);

  const registry = getMachineRegistry();
  const devices = await Promise.all(
    Object.entries(registry).map(async ([device, reg]): Promise<DeviceResult> => {
      return updateClientRelease(device, reg, latestVersion);
    })
  );

  const duration = Date.now() - start;
  saveReleaseState(latestVersion);

  for (const d of devices) {
    const status = d.updated && d.restarted ? 'OK' : (d.error ? 'FAIL' : 'SKIP');
    log.info(`  ${d.device}: ${status}${d.error ? ` (${d.error})` : ''}`);
  }

  return {
    mode: 'release',
    oldVersion,
    newVersion: latestVersion,
    devices,
    duration,
  };
}

// --- Slack message formatting ---

function formatUpdateSlackMessage(result: ClientUpdateResult): string {
  const modeLabel = result.mode === 'dev' ? '[dev]' : '[release]';
  const versionLabel = result.mode === 'dev'
    ? `mtime \`${result.oldVersion}\` → \`${result.newVersion}\``
    : `\`${result.oldVersion}\` → \`${result.newVersion}\``;

  const lines: string[] = [
    `${Icons.refresh} *Client hot-reload ${modeLabel}*  ${versionLabel}  (${(result.duration / 1000).toFixed(1)}s)`,
  ];

  for (const d of result.devices) {
    const icon = d.updated && d.restarted ? Icons.ok : Icons.error;
    lines.push(`  ${d.device}: ${icon}${d.error ? `  _${d.error}_` : ''}`);
  }

  return lines.join('\n');
}

export {
  checkAndUpdateClients,
  formatUpdateSlackMessage,
  updateClientReleaseLocal,
  buildRemoteNpmUpdateCommand,
};
export type { ClientUpdateResult, DeviceResult, LocalUpdateDeps };
