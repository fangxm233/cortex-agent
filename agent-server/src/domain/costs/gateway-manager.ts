import { spawn as childSpawn, ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createRequire } from 'module';
import { GATEWAY_CONFIG, DATA_DIR } from '@core/paths.js';
import { gatewayUrl, setActiveGatewayPort } from '@core/gateway-endpoint.js';
import { createLogger } from '@core/log.js';
import { GATEWAY_PID_FILE, chooseGatewayPort, reclaimOrphanGateway } from './gateway-port.js';

const log = createLogger('gateway-mgr');

// --- Config ---
// Resolve gateway CLI from the aistatus npm package (bin entry: ./dist/gateway-cli.js)
const require = createRequire(import.meta.url);
const aistatusDir = path.dirname(require.resolve('aistatus'));
const GATEWAY_CLI_PATH = path.join(aistatusDir, 'gateway-cli.js');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gateway.log');

// Restart backoff
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const HEALTHY_THRESHOLD_MS = 10_000; // if alive > 10s, reset backoff

// Health check
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

// --- State ---
let child: ChildProcess | null = null;
/** Chosen once per server run; crash restarts reuse it so running sessions keep their URL. */
let port: number | null = null;
let childStartedAt = 0;
let backoff = BACKOFF_INITIAL_MS;
let crashRestartTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let healthy = false;
let logStream: ReturnType<typeof createWriteStream> | null = null;

// --- File Logging ---
/** Log to both structured logger and gateway log file */
function gwLog(msg: string) {
  log.info(msg);
  try {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    getLogStream().write(`[gateway-mgr ${ts}] ${msg}\n`);
  } catch {}
}

function getLogStream() {
  if (!logStream) {
    mkdirSync(LOG_DIR, { recursive: true });
    logStream = createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return logStream;
}

const httpGet = (globalThis as { __mockHttpGet?: typeof http.get }).__mockHttpGet || http.get;
const spawnProcess = (globalThis as { __mockChildProcessSpawn?: typeof childSpawn }).__mockChildProcessSpawn || childSpawn;

// --- Health Check ---
function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(`${gatewayUrl()}/status`, { timeout: HEALTH_CHECK_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function runHealthCheck() {
  if (shuttingDown || !child) return;
  const wasHealthy = healthy;
  healthy = await checkHealth();
  if (wasHealthy && !healthy) {
    gwLog('Health check failed — gateway may be unresponsive');
  } else if (!wasHealthy && healthy) {
    gwLog('Health check passed — gateway is responsive');
  }
}

function isGatewayHealthy(): boolean {
  if (_healthOverride !== null) return _healthOverride;
  return healthy;
}

// --- Subprocess Management ---
/** Whatever already listens on a port is never reused: it may be another Cortex instance's
 *  gateway, holding that instance's credentials. Only this instance's own orphan is stopped. */
async function settlePort(): Promise<number> {
  await reclaimOrphanGateway(gwLog);
  const chosen = await chooseGatewayPort(gwLog);
  setActiveGatewayPort(chosen);
  // Children that inherited a stale CORTEX_GATEWAY_PORT (e.g. `cortex doctor` run by an agent).
  if (process.env.CORTEX_GATEWAY_PORT !== undefined) process.env.CORTEX_GATEWAY_PORT = String(chosen);
  return chosen;
}

function spawnGateway() {
  if (shuttingDown || port === null) return;
  if (child) {
    gwLog('spawnGateway called but child already running — skipping');
    return;
  }
  launchGateway(port);
}

function gatewayChildEnv(): NodeJS.ProcessEnv {
  if (!GATEWAY_CONFIG.home) return { ...process.env };
  mkdirSync(GATEWAY_CONFIG.home, { recursive: true });
  return { ...process.env, HOME: GATEWAY_CONFIG.home, USERPROFILE: GATEWAY_CONFIG.home };
}

function launchGateway(listenPort: number) {
  gwLog(`Starting aistatus gateway on ${gatewayUrl()}...`);
  childStartedAt = Date.now();
  healthy = false;

  const gatewayLogStream = getLogStream();

  // API dumps remain opt-in via GATEWAY_DUMP_DIR.
  const args = ['start', '-c', GATEWAY_CONFIG.configPath, '-p', String(listenPort), '--pid-file', GATEWAY_PID_FILE];
  child = spawnProcess(process.execPath, [GATEWAY_CLI_PATH, ...args], {
    cwd: DATA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: gatewayChildEnv(),
  });

  // Pipe gateway stdout/stderr to log file
  child.stdout?.on('data', (data: Buffer) => {
    gatewayLogStream.write(data);
  });
  child.stderr?.on('data', (data: Buffer) => {
    gatewayLogStream.write(data);
  });

  gwLog(`Gateway started — PID ${child.pid}`);

  child.on('exit', onGatewayExit);
  setTimeout(checkInitialHealth, 2000);
}

function onGatewayExit(code: number | null, signal: NodeJS.Signals | null) {
  const pid = child?.pid;
  child = null;
  healthy = false;

  if (shuttingDown) {
    gwLog(`Gateway exited (shutdown) — PID ${pid}`);
    return;
  }

  // Unexpected crash — schedule restart with backoff
  const alive = Date.now() - childStartedAt;
  if (alive > HEALTHY_THRESHOLD_MS) backoff = BACKOFF_INITIAL_MS;

  if (signal) {
    gwLog(`Gateway killed by signal ${signal} — PID ${pid}`);
  } else {
    gwLog(`Gateway exited with code ${code} — PID ${pid}`);
  }

  gwLog(`Restarting gateway in ${backoff}ms...`);
  crashRestartTimer = setTimeout(() => {
    crashRestartTimer = null;
    spawnGateway();
  }, backoff);
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
}

async function checkInitialHealth() {
  if (!child) return;
  healthy = await checkHealth();
  gwLog(healthy ? 'Gateway is healthy after startup' : 'Gateway not yet healthy after startup (will retry via periodic check)');
}

function killGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (!child) return resolve();

    const c = child;
    gwLog(`Stopping gateway (PID ${c.pid})...`);

    const forceKillTimer = setTimeout(() => {
      gwLog('Force killing gateway...');
      try { c.kill('SIGKILL'); } catch {}
    }, 5000);

    c.once('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    c.kill('SIGTERM');
  });
}

// --- Public API ---

/** Settle the gateway port and launch the gateway. Resolves once the port is fixed, so callers
 *  that await it hand every later spawn the URL the gateway really listens on. */
async function startGateway(): Promise<void> {
  shuttingDown = false;
  if (!existsSync(GATEWAY_CLI_PATH)) {
    gwLog(`Gateway CLI not found at ${GATEWAY_CLI_PATH} — cannot start gateway`);
    return;
  }
  try {
    port ??= await settlePort();
  } catch (error) {
    gwLog(`Could not choose a gateway port — gateway not started: ${(error as Error).message}`);
    return;
  }
  if (shuttingDown) return;
  spawnGateway();

  // Periodic health check
  healthCheckTimer = setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL_MS);
  gwLog(`Gateway manager started (health check interval: ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
}

async function stopGateway() {
  shuttingDown = true;

  // Cancel pending timers
  if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = null; }
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }

  await killGateway();

  // Close log stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  gwLog('Gateway manager stopped');
}

// Test-only: override isGatewayHealthy() return value (null = use real check)
let _healthOverride: boolean | null = null;
function _testSetHealthy(value: boolean | null) {
  _healthOverride = value;
}

export { startGateway, stopGateway, isGatewayHealthy, _testSetHealthy };
