// input:  utils, aistatus npm package, ~/.aistatus/gateway.yaml
// output: startGateway / stopGateway / isGatewayHealthy
// pos:    aistatus gateway subprocess lifecycle management
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { spawn as childSpawn, ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createRequire } from 'module';
import { DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('gateway-mgr');

// --- Config ---
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 9880;
const GATEWAY_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
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
    const req = httpGet(`${GATEWAY_URL}/status`, { timeout: HEALTH_CHECK_TIMEOUT_MS }, (res) => {
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
  if (shuttingDown) return;
  if (!child && !healthy) return;
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
async function adoptExistingGatewayIfHealthy(): Promise<boolean> {
  const existingHealthy = await checkHealth();
  if (!existingHealthy) return false;
  healthy = true;
  backoff = BACKOFF_INITIAL_MS;
  gwLog(`Gateway already healthy on ${GATEWAY_URL} — reusing existing process`);
  return true;
}

async function spawnGateway() {
  if (shuttingDown) return;
  if (child) {
    gwLog('spawnGateway called but child already running — skipping');
    return;
  }

  // Check that gateway CLI exists
  if (!existsSync(GATEWAY_CLI_PATH)) {
    gwLog(`Gateway CLI not found at ${GATEWAY_CLI_PATH} — cannot start gateway`);
    return;
  }

  if (await adoptExistingGatewayIfHealthy()) {
    return;
  }

  gwLog('Starting aistatus gateway (TS)...');
  childStartedAt = Date.now();
  healthy = false;

  const gatewayLogStream = getLogStream();

  // API dumps are OFF by default: the gateway writes one full request/response JSON per call with
  // no retention, which grew to 66 GB / 111k files in three months and filled the disk (ENOSPC
  // killed running threads). The env spread below still honours an explicitly exported
  // GATEWAY_DUMP_DIR, so debugging remains one `export` away — it is just never on by accident.
  const GATEWAY_CONFIG_PATH = path.join(os.homedir(), '.aistatus', 'gateway.yaml');
  child = spawnProcess(process.execPath, [GATEWAY_CLI_PATH, 'start', '-c', GATEWAY_CONFIG_PATH, '-p', String(GATEWAY_PORT)], {
    cwd: DATA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env },
  });

  // Pipe gateway stdout/stderr to log file
  child.stdout?.on('data', (data: Buffer) => {
    gatewayLogStream.write(data);
  });
  child.stderr?.on('data', (data: Buffer) => {
    gatewayLogStream.write(data);
  });

  gwLog(`Gateway started — PID ${child.pid}`);

  child.on('exit', (code, signal) => {
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
  });

  // Initial health check after a short delay to let gateway bind the port
  setTimeout(async () => {
    if (child) {
      healthy = await checkHealth();
      if (healthy) {
        gwLog('Gateway is healthy after startup');
      } else {
        gwLog('Gateway not yet healthy after startup (will retry via periodic check)');
      }
    }
  }, 2000);
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

function startGateway() {
  shuttingDown = false;
  void spawnGateway();

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

export { startGateway, stopGateway, isGatewayHealthy, GATEWAY_URL, _testSetHealthy };
