// input:  machine SSH targets, child_process, STORE_DIR
// output: supervised SSH reverse tunnels and safe argv builders
// pos:    Owns the persistent transport for SSH-routed clients
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';

const log = createLogger('client-ssh-tunnel');

export interface SshTunnelSpec {
  device: string;
  host: string;
  remotePort: number;
  serverPort: number;
}

type TunnelState = 'stopped' | 'starting' | 'running' | 'backoff' | 'stopping';
type ExecSsh = (args: string[], timeoutMs?: number) => Promise<string>;
type SpawnSsh = (args: string[]) => ChildProcess;

interface TunnelDeps {
  execSsh?: ExecSsh;
  spawnSsh?: SpawnSsh;
  controlDir?: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  stopTimeoutMs?: number;
}

interface TunnelRecord {
  spec: SshTunnelSpec;
  state: TunnelState;
  generation: number;
  child: ChildProcess | null;
  ensurePromise: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  lastError: Error | null;
}

const DEFAULT_CONTROL_DIR = path.join(STORE_DIR, 'client-ssh-tunnels');

function defaultExecSsh(args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

function defaultSpawnSsh(args: string[]): ChildProcess {
  return spawn('ssh', args, { stdio: 'ignore' });
}

export function buildSshTunnelArgs(spec: SshTunnelSpec, controlPath: string): string[] {
  return [
    '-M', '-S', controlPath, '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-R', `127.0.0.1:${spec.remotePort}:127.0.0.1:${spec.serverPort}`,
    spec.host,
  ];
}

function sameSpec(a: SshTunnelSpec, b: SshTunnelSpec): boolean {
  return a.host === b.host && a.remotePort === b.remotePort && a.serverPort === b.serverPort;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SshTunnelSupervisor {
  private readonly records = new Map<string, TunnelRecord>();
  private readonly execSsh: ExecSsh;
  private readonly spawnSsh: SpawnSsh;
  private readonly controlDir: string;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly stopTimeoutMs: number;
  private stopping = false;

  constructor(deps: TunnelDeps = {}) {
    this.execSsh = deps.execSsh ?? defaultExecSsh;
    this.spawnSsh = deps.spawnSsh ?? defaultSpawnSsh;
    this.controlDir = deps.controlDir ?? DEFAULT_CONTROL_DIR;
    this.retryBaseMs = deps.retryBaseMs ?? 1000;
    this.retryMaxMs = deps.retryMaxMs ?? 30_000;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 10_000;
    this.readyPollMs = deps.readyPollMs ?? 100;
    this.stopTimeoutMs = deps.stopTimeoutMs ?? 2000;
  }

  state(device: string): TunnelState {
    return this.records.get(device)?.state ?? 'stopped';
  }

  resume(): void {
    this.stopping = false;
  }

  ensure(spec: SshTunnelSpec): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('SSH tunnel supervisor is stopping'));
    const record = this.getOrCreate(spec);
    if (!sameSpec(record.spec, spec)) {
      return Promise.reject(new Error(`SSH tunnel route changed for ${spec.device}; restart the server`));
    }
    if (record.state === 'running') return Promise.resolve();
    if (record.ensurePromise) return record.ensurePromise;
    record.ensurePromise = this.start(record).finally(() => { record.ensurePromise = null; });
    return record.ensurePromise;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.records.values()].map((record) => this.stopRecord(record)));
  }

  private getOrCreate(spec: SshTunnelSpec): TunnelRecord {
    const existing = this.records.get(spec.device);
    if (existing) return existing;
    const record: TunnelRecord = {
      spec: { ...spec }, state: 'stopped', generation: 0, child: null,
      ensurePromise: null, retryTimer: null, attempt: 0, lastError: null,
    };
    this.records.set(spec.device, record);
    return record;
  }

  private controlPath(spec: SshTunnelSpec): string {
    fs.mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(`${spec.device}\0${spec.host}`).digest('hex').slice(0, 20);
    return path.join(this.controlDir, `${key}.sock`);
  }

  private controlArgs(record: TunnelRecord, operation: 'check' | 'exit'): string[] {
    return ['-S', this.controlPath(record.spec), '-O', operation, record.spec.host];
  }

  private async closeStaleMaster(record: TunnelRecord): Promise<void> {
    const socket = this.controlPath(record.spec);
    try {
      await this.execSsh(this.controlArgs(record, 'exit'), 3000);
      await delay(50);
    } catch {
      try { fs.unlinkSync(socket); } catch {}
    }
  }

  private async start(record: TunnelRecord): Promise<void> {
    const generation = ++record.generation;
    record.state = 'starting';
    record.lastError = null;
    await this.closeStaleMaster(record);
    if (!this.isCurrent(record, generation) || this.stopping) throw new Error('SSH tunnel start cancelled');
    const child = this.spawnSsh(buildSshTunnelArgs(record.spec, this.controlPath(record.spec)));
    record.child = child;
    this.attachChild(record, child, generation);
    await this.waitUntilReady(record, generation);
    if (!this.isCurrent(record, generation)) throw record.lastError ?? new Error('SSH tunnel start superseded');
    record.state = 'running';
    record.attempt = 0;
    log.info(`SSH reverse tunnel ready for ${record.spec.device} on remote port ${record.spec.remotePort}`);
  }

  private attachChild(record: TunnelRecord, child: ChildProcess, generation: number): void {
    child.once('error', (error) => this.fail(record, child, generation, error));
    child.once('exit', (code, signal) => {
      this.fail(record, child, generation, new Error(`SSH tunnel exited (${signal ?? code ?? 'unknown'})`));
    });
  }

  private async waitUntilReady(record: TunnelRecord, generation: number): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.isCurrent(record, generation)) throw record.lastError ?? new Error('SSH tunnel start failed');
      try {
        await this.execSsh(this.controlArgs(record, 'check'), 2000);
        return;
      } catch {
        await delay(this.readyPollMs);
      }
    }
    const error = new Error(`SSH tunnel for ${record.spec.device} was not ready within ${this.readyTimeoutMs}ms`);
    this.fail(record, record.child, generation, error);
    try { record.child?.kill('SIGTERM'); } catch {}
    throw error;
  }

  private isCurrent(record: TunnelRecord, generation: number): boolean {
    return record.generation === generation && record.state !== 'stopping' && record.state !== 'stopped';
  }

  private fail(record: TunnelRecord, child: ChildProcess | null, generation: number, error: Error): void {
    if (record.generation !== generation || record.child !== child) return;
    if (record.state === 'stopping' || record.state === 'stopped') return;
    record.child = null;
    record.lastError = error;
    record.state = 'backoff';
    log.warn(`${record.spec.device}: ${error.message}`);
    this.scheduleRetry(record);
  }

  private scheduleRetry(record: TunnelRecord): void {
    if (this.stopping || record.retryTimer) return;
    const wait = Math.min(this.retryBaseMs * (2 ** record.attempt), this.retryMaxMs);
    record.attempt += 1;
    record.retryTimer = setTimeout(() => {
      record.retryTimer = null;
      if (this.stopping) return;
      void this.ensure(record.spec).catch((error) => {
        log.warn(`${record.spec.device}: tunnel retry failed: ${(error as Error).message}`);
      });
    }, wait);
  }

  private async stopRecord(record: TunnelRecord): Promise<void> {
    record.generation += 1;
    record.state = 'stopping';
    if (record.retryTimer) clearTimeout(record.retryTimer);
    record.retryTimer = null;
    const child = record.child;
    record.child = null;
    try { await this.execSsh(this.controlArgs(record, 'exit'), 3000); } catch {}
    if (child) await this.stopChild(child);
    record.state = 'stopped';
    record.ensurePromise = null;
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try { child.kill('SIGTERM'); } catch { return; }
    const timedOut = await Promise.race([exited.then(() => false), delay(this.stopTimeoutMs).then(() => true)]);
    if (!timedOut) return;
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([exited, delay(this.stopTimeoutMs)]);
  }
}
