// input:  app process, temp Cortex home, mock observer
// output: settings migration and hot-reload E2E evidence
// pos:    Integration coverage for live settings behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_TS = path.join(TEST_ROOT, 'src', 'entry', 'cli.ts');
const APP_TS = path.join(TEST_ROOT, 'src', 'entry', 'app.ts');
const MOCK_ADAPTER_TS = path.join(TEST_ROOT, 'src', 'platform', 'testing.ts');
const EXECUTION_REGISTRY_TS = path.join(TEST_ROOT, 'src', 'domain', 'executions', 'registry.ts');
const TASK_DISPATCH_TS = path.join(TEST_ROOT, 'src', 'domain', 'scheduling', 'jobs', 'task-dispatch.ts');
const NODE = process.execPath;
const TSX_FLAGS = ['--import', 'tsx'];
const OLD_ORIGIN = 'https://old-settings.example';
const NEW_ORIGIN = 'https://new-settings.example';
const OLD_ADMIN = 'C-admin-old';
const NEW_ADMIN = 'C-admin-new';
const CLIENT_TOKEN = 'integration-client-token';
const WEBHOOK_TOKEN = 'integration-webhook-token';

const legacyLines = [
  'CORTEX_TURN_NOTIFY=off',
  'CORTEX_TURN_NOTIFY_THRESHOLD_S=12.5',
  'CORTEX_NOTIFY_COMPACTION=1',
  'CORTEX_SHOW_TOOL_CALLS=off',
  'CORTEX_STATUS_NEWQ_BUTTON=on',
  'CORTEX_AUTO_RESUME=false',
  'CORTEX_STREAM_DELTAS=0',
  'CORTEX_BG_CONTINUATION=no',
  'CORTEX_EVENT_LOG=off',
  'CORTEX_DISABLE_USER_CONTEXT=1',
  'CORTEX_SERVER_UPDATE_DISABLE=1',
  'CORTEX_HOOKS_LEGACY=1',
  'CORTEX_MANAGER_ROTATE_STEPS=12steps',
  'CORTEX_WAITING_SWEEP_MS=0',
  'CORTEX_INJECT_WAIT_MAX_S=2.5',
  'CORTEX_THREAD_MAX_DEPTH=7levels',
  'CORTEX_TASK_ARTIFACT_TEMPLATES="manager, coder-review"',
  'TASK_DISPATCH_MAX_CONCURRENT=1worker',
  `CORTEX_UI_CORS_ORIGINS=${OLD_ORIGIN}`,
  `CORTEX_ADMIN_CHANNEL=${OLD_ADMIN}`,
  'FEISHU_ADMIN_CHANNEL=oc_admin_old',
];

const migratedSettings = {
  turnNotify: false,
  turnNotifyThresholdS: 12.5,
  notifyCompaction: true,
  showToolCalls: false,
  statusNewqButton: true,
  autoResume: false,
  streamDeltas: false,
  bgContinuation: false,
  eventLog: false,
  disableUserContext: true,
  serverUpdateDisable: true,
  hooksLegacy: true,
  managerRotateSteps: 12,
  waitingSweepMs: 0,
  injectWaitMaxS: 2.5,
  threadMaxDepth: 7,
  taskArtifactTemplates: ['manager', 'coder-review'],
  taskDispatchMaxConcurrent: 1,
  uiCorsOrigins: [OLD_ORIGIN],
  adminChannel: OLD_ADMIN,
  feishuAdminChannel: 'oc_admin_old',
};

interface ChildLogs {
  stdout: string;
  stderr: string;
}

interface ObserverRecord {
  type: 'post';
  destination: { type: string };
  content: { text?: string };
  ref: { conduit: string; messageId: string };
}

interface ScenarioPaths {
  home: string;
  envFile: string;
  settingsFile: string;
  schedulesFile: string;
  evidenceFile: string;
  observerFile: string;
  binDir: string;
  originalEnv: string;
}

const liveChildren = new Set<ChildProcess>();

afterAll(() => {
  reapAll();
  liveChildren.clear();
});

function reapAll(): void {
  for (const child of liveChildren) killTree(child);
}

process.on('exit', reapAll);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    reapAll();
    process.exit(1);
  });
}

function randomPort(): number {
  return 40_000 + Math.floor(Math.random() * 25_000);
}

function trackedSpawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  liveChildren.add(child);
  child.on('close', () => liveChildren.delete(child));
  return child;
}

function trackedFork(modulePath: string, options: Parameters<typeof fork>[2]): ChildProcess {
  const child = fork(modulePath, [], { ...options, detached: true });
  liveChildren.add(child);
  child.on('close', () => liveChildren.delete(child));
  return child;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child);
      resolve(null);
    }, timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitFor(condition: () => boolean, message: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(check, 25);
    };
    check();
  });
}

function isolatedBaseEnv(home: string): NodeJS.ProcessEnv {
  const blockedPrefixes = ['CORTEX_', 'SLACK_', 'FEISHU_', 'ANTHROPIC_', 'CF_ACCESS_', 'CLOUDFLARE_', 'FISH_'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !blockedPrefixes.some((prefix) => key.startsWith(prefix)) && key !== 'GITHUB_WEBHOOK_SECRET'));
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CORTEX_HOME: home,
    CORTEX_PROJECTS_DIR: path.join(home, 'context', 'projects'),
  };
}

function spawnWait(
  command: string,
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = trackedSpawn(command, args, {
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
    child.stdin?.end(stdin);
  });
}

async function cortexInit(home: string): Promise<void> {
  const result = await spawnWait(NODE, [
    ...TSX_FLAGS,
    CLI_TS,
    'init',
    '--home', home,
    '--gateway-config-dir', path.join(home, 'aistatus'),
  ], 'claude\nnone\nn\nn\nn\nn\nn\nn\n', isolatedBaseEnv(home));
  assert.equal(result.code, 0, `cortex init failed:\n${result.stderr}`);
}

function fakeClaudeSource(): string {
  return `#!/usr/bin/env node
import { createInterface } from 'node:readline';
let turn = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  turn += 1;
  const sessionId = request.session_id;
  const toolId = 'tool-' + turn;
  console.log(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'echo integration-' + turn } }
  ] } }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'integration-reply-' + turn }
  ] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: sessionId, result: 'integration-reply-' + turn,
    total_cost_usd: 0, num_turns: 1 }));
});
`;
}

function observerSource(evidenceFile: string): string {
  const mockUrl = pathToFileURL(MOCK_ADAPTER_TS).href;
  const registryUrl = pathToFileURL(EXECUTION_REGISTRY_TS).href;
  const dispatchUrl = pathToFileURL(TASK_DISPATCH_TS).href;
  return `import { appendFileSync } from 'node:fs';
const { MockAdapter } = await import(${JSON.stringify(mockUrl)});
const append = (value) => appendFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify(value) + '\\n');
const originalPost = MockAdapter.prototype.postMessage;
MockAdapter.prototype.postMessage = async function(destination, content, opts) {
  const ref = await originalPost.call(this, destination, content, opts);
  append({ type: 'post', destination, content, ref });
  return ref;
};
const handlers = {
  'integration-simulate-message': (adapter, message) => adapter.simulateMessage(message.channel, message.text),
  'integration-register-dispatch': async () => (await import(${JSON.stringify(registryUrl)}))
    .registerDispatchExecution({ taskId: 'integration-remote', machine: 'remote-fixture',
      channel: 'integration', project: 'general', taskText: 'integration fixture' }),
  'integration-run-dispatch': async () => (await import(${JSON.stringify(dispatchUrl)}))
    .taskDispatchRunner({ channel: 'general', scheduleTaskId: 'seed0001', profileName: 'plan' }),
};
const originalStart = MockAdapter.prototype.start;
MockAdapter.prototype.start = async function(...args) {
  await originalStart.apply(this, args);
  process.on('message', async (message) => {
    const handler = handlers[message?.type];
    if (!handler || !message.integrationRequestId) return;
    let error;
    try { await handler(this, message); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    process.send?.({ type: 'integration-ack', integrationRequestId: message.integrationRequestId, error });
  });
};
`;
}

function pauseDispatchSchedule(schedulesFile: string): void {
  const data = JSON.parse(readFileSync(schedulesFile, 'utf8'));
  const dispatch = data.tasks.find((task: any) => task.dispatchType === 'task-dispatch');
  assert.ok(dispatch, 'initialized schedules must contain task-dispatch');
  data.tasks = [{ ...dispatch, isPaused: true, pausedAt: Date.now(), pausedBy: 'user', nextRun: null }];
  writeFileSync(schedulesFile, `${JSON.stringify(data, null, 2)}\n`);
}

function armDispatchSchedule(schedulesFile: string): void {
  const data = JSON.parse(readFileSync(schedulesFile, 'utf8'));
  const dispatch = data.tasks[0];
  data.tasks = [{
    ...dispatch,
    isPaused: false,
    pausedAt: null,
    pausedBy: null,
    intervalMs: 500,
    nextRun: Date.now() + 100,
  }];
  writeFileSync(schedulesFile, `${JSON.stringify(data, null, 2)}\n`);
}

async function prepareScenario(): Promise<ScenarioPaths> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cortex-settings-int-'));
  await cortexInit(home);
  const envFile = path.join(home, 'config', '.env');
  const originalEnv = [
    '# integration fixture',
    `CORTEX_CLIENT_TOKEN=${CLIENT_TOKEN}`,
    `CORTEX_WEBHOOK_TOKEN=${WEBHOOK_TOKEN}`,
    ...legacyLines,
    'KEEP_ME=preserved',
    '',
  ].join('\n');
  writeFileSync(envFile, originalEnv);
  const schedulesFile = path.join(home, 'data', 'schedules.json');
  pauseDispatchSchedule(schedulesFile);
  const binDir = path.join(home, 'test-bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = path.join(binDir, 'claude');
  writeFileSync(fakeClaude, fakeClaudeSource());
  chmodSync(fakeClaude, 0o755);
  const evidenceFile = path.join(home, 'observer.jsonl');
  const observerFile = path.join(home, 'observer.mjs');
  writeFileSync(observerFile, observerSource(evidenceFile));
  return { home, envFile, settingsFile: path.join(home, 'config', 'settings.json'), schedulesFile,
    evidenceFile, observerFile, binDir, originalEnv };
}

function startServer(paths: ScenarioPaths): { child: ChildProcess; logs: ChildLogs } {
  const logs: ChildLogs = { stdout: '', stderr: '' };
  const child = trackedFork(APP_TS, {
    cwd: TEST_ROOT,
    execArgv: [...TSX_FLAGS, '--import', paths.observerFile],
    env: {
      ...isolatedBaseEnv(paths.home),
      PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      CORTEX_HOME: paths.home,
      CORTEX_PLATFORM: 'test',
      CORTEX_TUI: '0',
      CORTEX_UI_HTTP: '1',
      CORTEX_UI_PORT: '0',
      WEBHOOK_PORT: String(randomPort()),
      CORTEX_CLIENT_PORT: String(randomPort()),
      CORTEX_CLIENT_TOKEN: CLIENT_TOKEN,
      CORTEX_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      CORTEX_GPU_MONITOR_MOCK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { logs.stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { logs.stderr += chunk.toString(); });
  return { child, logs };
}

function observerRecords(file: string): ObserverRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function eventLogText(home: string): string {
  const dir = path.join(home, 'logs', 'events');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => name.startsWith('events-') && name.endsWith('.jsonl'))
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

function sendIntegrationRequest(child: ChildProcess, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const integrationRequestId = `${type}-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`IPC request timed out: ${type}`)), 20_000);
    const onMessage = (message: any) => {
      if (message?.type !== 'integration-ack' || message.integrationRequestId !== integrationRequestId) return;
      finish(message.error ? new Error(message.error) : null);
    };
    const finish = (error: Error | null) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      if (error) reject(error); else resolve();
    };
    child.on('message', onMessage);
    child.send({ type, integrationRequestId, ...payload });
  });
}

async function sendDaemonNotice(child: ChildProcess, evidenceFile: string, text: string): Promise<ObserverRecord> {
  const before = observerRecords(evidenceFile).length;
  child.send({ type: 'rebuild-aborted', text });
  await waitFor(
    () => observerRecords(evidenceFile).slice(before).some((record) => record.content.text === text),
    `daemon notice was not observed: ${text}`,
  );
  return observerRecords(evidenceFile).slice(before).find((record) => record.content.text === text)!;
}

function uiPort(logs: ChildLogs): number {
  const match = logs.stdout.match(/Listening on 127\.0\.0\.1:(\d+)\/trpc\//);
  assert.ok(match, `UI port missing from stdout:\n${logs.stdout.slice(0, 4000)}`);
  return Number(match[1]);
}

async function corsHeader(port: number, origin: string): Promise<string | null> {
  const input = encodeURIComponent(JSON.stringify({}));
  const response = await fetch(`http://127.0.0.1:${port}/trpc/projects.list?input=${input}`, {
    headers: { 'x-cortex-token': CLIENT_TOKEN, Origin: origin },
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('access-control-allow-origin');
}

function assertMigration(paths: ScenarioPaths): void {
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, 'utf8')), migratedSettings);
  const migratedEnv = readFileSync(paths.envFile, 'utf8');
  for (const line of legacyLines) {
    assert.doesNotMatch(migratedEnv, new RegExp(`^${line.split('=')[0]}=`, 'm'));
  }
  assert.match(migratedEnv, /^KEEP_ME=preserved$/m);
  const backups = readdirSync(path.dirname(paths.envFile)).filter((name) => name.startsWith('.env.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(path.dirname(paths.envFile), backups[0]), 'utf8'), paths.originalEnv);
}

async function proveInitialBehavior(child: ChildProcess, logs: ChildLogs, paths: ScenarioPaths): Promise<number> {
  const beforeMessage = observerRecords(paths.evidenceFile).length;
  await sendIntegrationRequest(child, 'integration-simulate-message', { channel: 'integration', text: 'before reload' });
  await waitFor(
    () => observerRecords(paths.evidenceFile).slice(beforeMessage)
      .some((record) => record.content.text?.includes('integration-reply-1')),
    `assistant reply was not observed: ${JSON.stringify(observerRecords(paths.evidenceFile).slice(beforeMessage))}`,
  );
  const messageRecords = observerRecords(paths.evidenceFile).slice(beforeMessage);
  assert.ok(!messageRecords.some((record) => /Bash ×1/.test(record.content.text ?? '')));

  const notice = await sendDaemonNotice(child, paths.evidenceFile, 'event-log-off-marker');
  assert.equal(notice.ref.conduit, OLD_ADMIN);
  assert.doesNotMatch(eventLogText(paths.home), /event-log-off-marker/);

  await sendIntegrationRequest(child, 'integration-register-dispatch');
  armDispatchSchedule(paths.schedulesFile);
  await waitFor(() => logs.stdout.includes('Skipping — at concurrency limit (1/1)'),
    `dispatch limit was not observed:\n${logs.stdout.slice(-4000)}`);
  const port = uiPort(logs);
  assert.equal(await corsHeader(port, OLD_ORIGIN), OLD_ORIGIN);
  return port;
}

function writeHotSettings(settingsFile: string): void {
  const next = {
    ...migratedSettings,
    showToolCalls: true,
    eventLog: true,
    taskDispatchMaxConcurrent: 2,
    uiCorsOrigins: [NEW_ORIGIN],
    adminChannel: NEW_ADMIN,
  };
  writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
}

async function proveToolTrace(child: ChildProcess, evidenceFile: string): Promise<void> {
  const before = observerRecords(evidenceFile).length;
  await sendIntegrationRequest(child, 'integration-simulate-message', { channel: 'integration', text: 'after reload' });
  await waitFor(
    () => observerRecords(evidenceFile).slice(before)
      .some((record) => /Bash ×1/.test(record.content.text ?? '')),
    `tool trace was not observed: ${JSON.stringify(observerRecords(evidenceFile).slice(before))}`,
  );
}

async function proveEventAdminAndDispatch(
  child: ChildProcess,
  logs: ChildLogs,
  paths: ScenarioPaths,
): Promise<void> {
  const notice = await sendDaemonNotice(child, paths.evidenceFile, 'event-log-on-marker');
  assert.equal(notice.ref.conduit, NEW_ADMIN);
  await waitFor(() => /event-log-on-marker/.test(eventLogText(paths.home)), 'enabled event log did not persist notice');
  await sendIntegrationRequest(child, 'integration-run-dispatch');
  await waitFor(() => logs.stdout.includes('Cycle complete: No dispatchable tasks available'),
    `dispatch did not pass the raised limit:\n${logs.stdout.slice(-4000)}`);
}

function printEvidence(pid: number | undefined): void {
  console.info([
    '[settings-hotreload-e2e]',
    `same-pid=${pid}`,
    'Hot-reload: settings.json reloaded',
    'dispatch-before=Skipping — at concurrency limit (1/1)',
    'dispatch-after=Cycle complete: No dispatchable tasks available',
    'tool-trace-after=Bash ×1',
    `admin-before=${OLD_ADMIN} admin-after=${NEW_ADMIN}`,
    `cors-before=${OLD_ORIGIN} cors-after=${NEW_ORIGIN}`,
    'event-before=absent event-after=event-log-on-marker',
  ].join('\n'));
}

async function proveReloadedBehavior(
  child: ChildProcess,
  logs: ChildLogs,
  paths: ScenarioPaths,
  port: number,
): Promise<void> {
  const pid = child.pid;
  writeHotSettings(paths.settingsFile);
  await waitFor(() => logs.stdout.includes('Hot-reload: settings.json reloaded'),
    `settings hot-reload log missing:\n${logs.stdout.slice(-4000)}`);
  assert.equal(child.pid, pid);
  await proveToolTrace(child, paths.evidenceFile);
  await proveEventAdminAndDispatch(child, logs, paths);
  assert.equal(await corsHeader(port, OLD_ORIGIN), null);
  assert.equal(await corsHeader(port, NEW_ORIGIN), NEW_ORIGIN);
  printEvidence(pid);
}

async function runScenario(): Promise<void> {
  const paths = await prepareScenario();
  let child: ChildProcess | null = null;
  try {
    const started = startServer(paths);
    child = started.child;
    await waitFor(
      () => started.logs.stdout.includes('Cortex agent is running') && /Listening on 127\.0\.0\.1:\d+\/trpc\//.test(started.logs.stdout),
      `server readiness timed out:\nstdout=${started.logs.stdout.slice(-5000)}\nstderr=${started.logs.stderr.slice(-5000)}`,
      60_000,
    );
    assertMigration(paths);
    const port = await proveInitialBehavior(child, started.logs, paths);
    await proveReloadedBehavior(child, started.logs, paths, port);
    child.kill('SIGTERM');
    assert.equal(await waitForExit(child), 0, `server did not stop cleanly:\n${started.logs.stderr.slice(-4000)}`);
  } finally {
    if (child) killTree(child);
    rmSync(paths.home, { recursive: true, force: true });
  }
}

test('real server migrates all legacy settings and hot-reloads observable consumers', async () => {
  await runScenario();
}, 120_000);
