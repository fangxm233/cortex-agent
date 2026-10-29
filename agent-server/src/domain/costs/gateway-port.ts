import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { atomicWriteSync } from '@core/atomic-write.js';
import { upsertEnvVar } from '@core/env-file.js';
import { DEFAULT_GATEWAY_PORT, savedGatewayPort } from '@core/gateway-config.js';
import { CONFIG_DIR, GATEWAY_CONFIG, STORE_DIR } from '@core/paths.js';
import { processCommandLine } from '@core/process-command-line.js';
import { isProcessAlive } from '@core/singleton-lock.js';

/** Written by the gateway child once it listens (`--pid-file`), removed when it stops cleanly. */
export const GATEWAY_PID_FILE = path.join(STORE_DIR, 'gateway.pid');

const SCAN_SPAN = 100;
const TERM_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const EXIT_POLL_MS = 100;

type Log = (message: string) => void;

/** True when nothing listens on 127.0.0.1:port. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function osAssignedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The first free port above `after`, scanning a short range so the choice is stable across
 *  restarts; the OS picks one when the whole range is taken. */
async function nextFreePort(after: number): Promise<number> {
  for (let port = after + 1; port <= Math.min(after + SCAN_SPAN, 65535); port++) {
    if (await isPortFree(port)) return port;
  }
  return osAssignedPort();
}

function readPidFile(): number | null {
  try {
    const pid = Number(readFileSync(GATEWAY_PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** A live process that was started as this instance's gateway: the pid file alone could name a
 *  recycled pid, so the command line must also carry the gateway CLI and this pid file. */
function isOwnGateway(pid: number): boolean {
  if (pid === process.pid || !isProcessAlive(pid)) return false;
  const command = processCommandLine(pid);
  return command !== null && command.includes('gateway-cli') && command.includes(GATEWAY_PID_FILE);
}

function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); } catch { /* already gone */ }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, EXIT_POLL_MS));
  }
  return true;
}

/**
 * Stop a gateway this instance started in an earlier server run that died without stopping it
 * (a SIGKILLed app.js leaves its child running). It still holds its port, and this instance must
 * not route through a process it does not supervise.
 */
export async function reclaimOrphanGateway(log: Log): Promise<void> {
  const pid = readPidFile();
  if (pid === null || !isOwnGateway(pid)) return;
  log(`Stopping gateway PID ${pid} left running by an earlier server run`);
  signal(pid, 'SIGTERM');
  if (await waitForExit(pid, TERM_WAIT_MS)) return;
  signal(pid, 'SIGKILL');
  await waitForExit(pid, KILL_WAIT_MS);
}

/** Point gateway.yaml's top-level `port:` at the bound port, leaving the rest of the file as
 *  written. The gateway takes its port from `-p`, so this only keeps the file truthful. */
function rewriteGatewayYamlPort(port: number): void {
  let text: string;
  try { text = readFileSync(GATEWAY_CONFIG.configPath, 'utf8'); } catch { return; }
  const next = text.replace(/^port:[ \t]*\d+/m, `port: ${port}`);
  if (next !== text) atomicWriteSync(GATEWAY_CONFIG.configPath, next);
}

function readSavedPort(): number | undefined {
  try { return savedGatewayPort(CONFIG_DIR); } catch { return undefined; }
}

async function firstFreeCandidate(candidates: Array<number | undefined>): Promise<number | null> {
  for (const port of new Set(candidates)) {
    if (port !== undefined && await isPortFree(port)) return port;
  }
  return null;
}

/**
 * Choose the port for this server run: the configured port (process env, then config/.env), the
 * saved port, the default, and otherwise the next free port. A port that differs from the
 * configured one is saved to config/.env so CLI processes such as `cortex doctor` find it, and
 * the next run starts from it.
 */
export async function chooseGatewayPort(log: Log): Promise<number> {
  const configured = GATEWAY_CONFIG.port;
  const saved = readSavedPort();
  const port = await firstFreeCandidate([configured, saved, DEFAULT_GATEWAY_PORT])
    ?? await nextFreePort(configured);
  if (port === configured) return port;
  log(`Gateway port ${configured} is used by another process; the gateway listens on ${port}`);
  await recordMovedPort(port, saved, log);
  return port;
}

/** Replace a port another process bound between the free-port probe and the gateway's own bind
 *  (two instances starting at once can pick the same one). The next free port above it is taken
 *  and saved. */
export async function repickGatewayPort(taken: number, log: Log): Promise<number> {
  const port = await nextFreePort(taken);
  log(`Gateway port ${taken} was taken by another process before the gateway came up; the gateway listens on ${port}`);
  await recordMovedPort(port, readSavedPort(), log);
  return port;
}

async function recordMovedPort(port: number, saved: number | undefined, log: Log): Promise<void> {
  try {
    if (port !== saved) await saveMovedPort(port, log);
    rewriteGatewayYamlPort(port);
  } catch (error) {
    log(`Could not save gateway port ${port}: ${(error as Error).message}`);
  }
}

async function saveMovedPort(port: number, log: Log): Promise<void> {
  await upsertEnvVar(path.join(CONFIG_DIR, '.env'), 'CORTEX_GATEWAY_PORT', String(port));
  log(`Saved CORTEX_GATEWAY_PORT=${port} to config/.env`);
}
