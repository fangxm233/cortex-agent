// input:  physical trial state root, task/thread/session records
// output: root-confined task, thread, session and execution stores
// pos:    Trial-local persistence owned by standalone agent-run
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncMutex } from '../../core/async-mutex.js';
import { atomicWrite } from '../../core/atomic-write.js';
import type { Task } from '../../core/task-parser.js';
import type { ThreadId, ThreadRecord } from '../../core/types/thread-types.js';
import type {
  ExecutionOutcomeMetrics, ExecutionStorePort, LocalExecutionStartInput, SessionStorePort,
  ThreadStorePort,
} from '../threads/local-runtime-deps.js';
import type { TrialTaskRepositoryDelegate } from '../benchmark/trial-task-ports.js';

interface StandaloneSessionRecord {
  name: string;
  sessionId: string;
  channel: string;
  backend: string;
  kind: 'local' | 'scheduled';
  origin: 'direct' | 'thread' | 'scheduled';
  projectId: string;
  label: string | null;
  profileName: string | null;
  backendSessionId: string | null;
  scheduleId: string | null;
  createdAt: string;
}

interface StandaloneExecutionRecord extends LocalExecutionStartInput {
  id: string;
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  metrics: ExecutionOutcomeMetrics;
}

class DurableRecordStore<T> {
  readonly filePath: string;
  private readonly rootPath: string;
  private values: Record<string, T>;
  private pending: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    const requestedRoot = path.resolve(path.dirname(filePath));
    fs.mkdirSync(requestedRoot, { recursive: true });
    this.rootPath = fs.realpathSync(requestedRoot);
    if (this.rootPath !== requestedRoot) {
      throw new Error(`Standalone store root must be physical: ${requestedRoot}`);
    }
    this.filePath = path.join(this.rootPath, path.basename(filePath));
    this.values = this.readFile();
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '{}\n', { flag: 'wx' });
    this.assertBoundary();
  }

  private assertBoundary(): void {
    const root = fs.lstatSync(this.rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()
        || fs.realpathSync(this.rootPath) !== this.rootPath) {
      throw new Error(`Standalone store root changed after resolution: ${this.rootPath}`);
    }
    if (!fs.existsSync(this.filePath)) return;
    const file = fs.lstatSync(this.filePath);
    if (!file.isFile() || file.isSymbolicLink()
        || fs.realpathSync(this.filePath) !== this.filePath) {
      throw new Error(`Standalone store file escaped its physical root: ${this.filePath}`);
    }
  }

  private readFile(): Record<string, T> {
    this.assertBoundary();
    if (!fs.existsSync(this.filePath)) return {};
    const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Standalone store must contain a JSON object: ${this.filePath}`);
    }
    return value as Record<string, T>;
  }

  get(id: string): T | null {
    return this.values[id] ?? null;
  }

  all(): T[] {
    return Object.values(this.values);
  }

  set(id: string, value: T): Promise<void> {
    this.values[id] = value;
    return this.queuePersist();
  }

  mutate(id: string, fn: (value: T) => void): Promise<void> {
    const value = this.values[id];
    if (value === undefined) return this.pending;
    fn(value);
    return this.queuePersist();
  }

  load(): void {
    this.values = this.readFile();
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private queuePersist(): Promise<void> {
    const snapshot = structuredClone(this.values);
    this.pending = this.pending.then(() => {
      this.assertBoundary();
      return atomicWrite(this.filePath, `${JSON.stringify(snapshot)}\n`);
    });
    // Sync runtime ports may intentionally defer this write; flush still observes the rejection.
    void this.pending.catch(() => {});
    return this.pending;
  }
}

export class StandaloneTaskStore implements TrialTaskRepositoryDelegate {
  private readonly records: DurableRecordStore<Task>;
  private readonly exclusive = new AsyncMutex();

  constructor(readonly filePath: string) {
    this.records = new DurableRecordStore(filePath);
  }

  getById(taskId: string): Task | null { return this.records.get(taskId); }
  getAll(project?: string): Task[] {
    return this.records.all().filter(task => project === undefined || task.project === project);
  }
  getActionable(): Task[] {
    const done = new Set(this.records.all().filter(task => task.status === 'done').map(task => task.id));
    return this.records.all().filter(task => task.status === 'open' && !task.blocked_by
      && !task.paused && task.depends_on.every(id => done.has(id)));
  }
  refresh(): void { this.records.load(); }
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> { return this.exclusive.run(fn); }
  flush(): Promise<void> { return this.records.flush(); }
  set(task: Task): Promise<void> { return this.records.set(task.id, task); }
}

export class StandaloneThreadStore implements ThreadStorePort {
  private readonly records: DurableRecordStore<ThreadRecord>;

  constructor(readonly filePath: string) {
    this.records = new DurableRecordStore(filePath);
  }

  get(id: ThreadId): ThreadRecord | null { return this.records.get(id); }
  getAll(): ThreadRecord[] { return this.records.all(); }
  set(record: ThreadRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    return this.records.set(record.id, record);
  }
  mutate(id: ThreadId, fn: (thread: ThreadRecord) => void): Promise<void> {
    return this.records.mutate(id, (thread) => {
      fn(thread);
      thread.updatedAt = new Date().toISOString();
    });
  }
  load(): void { this.records.load(); }
  flush(): Promise<void> { return this.records.flush(); }
}

export class StandaloneSessionStore implements SessionStorePort {
  private readonly records: DurableRecordStore<StandaloneSessionRecord>;

  constructor(readonly filePath: string) {
    this.records = new DurableRecordStore(filePath);
  }

  async generateSessionName(): Promise<string> {
    return `cortex-${randomBytes(4).toString('hex')}`;
  }

  registerSession(name: string, options: Parameters<SessionStorePort['registerSession']>[1]) {
    const record: StandaloneSessionRecord = {
      name,
      sessionId: options.sessionId,
      channel: options.channel,
      backend: options.backend,
      kind: options.kind,
      origin: options.origin ?? (options.kind === 'scheduled' ? 'scheduled' : 'direct'),
      projectId: options.projectId ?? 'benchmark',
      label: options.label ?? null,
      profileName: options.profileName ?? null,
      backendSessionId: options.backendSessionId ?? null,
      scheduleId: options.scheduleId ?? null,
      createdAt: new Date().toISOString(),
    };
    return this.records.set(record.sessionId, record);
  }

  flush(): Promise<void> { return this.records.flush(); }
}

export class StandaloneExecutionStore implements ExecutionStorePort {
  private readonly records: DurableRecordStore<StandaloneExecutionRecord>;

  constructor(readonly filePath: string) {
    this.records = new DurableRecordStore(filePath);
  }

  startLocalExecution(input: LocalExecutionStartInput): StandaloneExecutionRecord {
    const record = {
      ...input,
      id: `exec_local_${randomUUID()}`,
      kind: input.kind ?? 'local',
      status: 'running' as const,
      metrics: {},
    };
    void this.records.set(record.id, record);
    return record;
  }

  completeExecution(id: string, metrics: ExecutionOutcomeMetrics = {}) {
    return this.finish(id, 'completed', metrics);
  }
  cancelExecution(id: string, metrics: ExecutionOutcomeMetrics = {}) {
    return this.finish(id, 'cancelled', metrics);
  }
  failExecution(id: string, metrics: ExecutionOutcomeMetrics = {}) {
    return this.finish(id, 'failed', metrics);
  }
  load(): void { this.records.load(); }
  flush(): Promise<void> { return this.records.flush(); }

  private finish(
    id: string,
    status: StandaloneExecutionRecord['status'],
    metrics: ExecutionOutcomeMetrics,
  ): StandaloneExecutionRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    record.status = status;
    record.metrics = { ...record.metrics, ...metrics };
    void this.records.set(id, record);
    return record;
  }
}

export interface StandaloneStoreBundle {
  root: string;
  files: { tasks: string; threads: string; sessions: string; executions: string };
  tasks: StandaloneTaskStore;
  threads: StandaloneThreadStore;
  sessions: StandaloneSessionStore;
  executions: StandaloneExecutionStore;
  flush(): Promise<void>;
}

function stateFiles(root: string): StandaloneStoreBundle['files'] {
  return {
    tasks: path.join(root, 'tasks.json'),
    threads: path.join(root, 'threads.json'),
    sessions: path.join(root, 'sessions.json'),
    executions: path.join(root, 'executions.json'),
  };
}

function assertFreshStateRoot(root: string): void {
  if (!fs.existsSync(root)) return;
  if (fs.readdirSync(root).length > 0) {
    throw new Error(`Standalone trial state root must be fresh: ${root}`);
  }
}

export function createStandaloneStores(
  root: string,
  requireFresh: boolean,
): StandaloneStoreBundle {
  const resolved = path.resolve(root);
  if (requireFresh) assertFreshStateRoot(resolved);
  fs.mkdirSync(resolved, { recursive: true });
  const files = stateFiles(resolved);
  const tasks = new StandaloneTaskStore(files.tasks);
  const threads = new StandaloneThreadStore(files.threads);
  const sessions = new StandaloneSessionStore(files.sessions);
  const executions = new StandaloneExecutionStore(files.executions);
  return {
    root: resolved, files, tasks, threads, sessions, executions,
    flush: async () => {
      await Promise.all([
        tasks.flush(), threads.flush(), sessions.flush(), executions.flush(),
      ]);
    },
  };
}
