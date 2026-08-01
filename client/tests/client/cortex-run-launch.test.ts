// input:  node:test, temporary filesystem, cortex-run launch module
// output: launch, cancel, callback generation, orphan, and ack tests
// pos:    Verifies durable cortex-run client lifecycle behavior
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

// Merged into one file to avoid ESM module-cache isolation issues with CORTEX_HOME.
import { describe, it, mock, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set CORTEX_HOME BEFORE any dynamic import to a temp dir.
const testHome = mkdtempSync(join(tmpdir(), 'cortex-test-'));
process.env.CORTEX_HOME = testHome;

// Dynamic import ensures the env var is set before module evaluation.
let CORTEX_RUN_DIR: string;
let handleCortexRunLaunch: any;
let handleCortexRunCancel: any;
let isPidAlive: any;
let readJsonSafe: any;
let tailFile: any;
let findRunDirByCallbackId: any;
let tryUnlink: any;
let flushPendingCallbacks: any;
let synthesizeOrphanResult: any;
type CortexRunLaunchParams = any;
type CortexRunCancelParams = any;

before(async () => {
  const mod = await import('../../src/cortex-run-launch.js');
  CORTEX_RUN_DIR = mod.CORTEX_RUN_DIR;
  handleCortexRunLaunch = mod.handleCortexRunLaunch;
  handleCortexRunCancel = mod.handleCortexRunCancel;
  isPidAlive = mod.isPidAlive;
  readJsonSafe = mod.readJsonSafe;
  tailFile = mod.tailFile;
  findRunDirByCallbackId = mod.findRunDirByCallbackId;
  tryUnlink = mod.tryUnlink;
  flushPendingCallbacks = mod.flushPendingCallbacks;
  synthesizeOrphanResult = mod.synthesizeOrphanResult;
});

after(() => {
  rmSync(testHome, { recursive: true, force: true });
});

// ========================================================================
// Utility Functions
// ========================================================================

describe('isPidAlive', () => {
  it('returns false for a non-existent PID', () => {
    assert.strictEqual(isPidAlive(0x7ffffffe), false);
  });

  it('returns true for the current process (always alive)', () => {
    assert.strictEqual(isPidAlive(process.pid), true);
  });
});

describe('readJsonSafe', () => {
  it('returns null for missing file', () => {
    assert.strictEqual(readJsonSafe('/nonexistent/path.json'), null);
  });

  it('returns null for invalid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'readjson-'));
    try {
      writeFileSync(join(tmpDir, 'bad.json'), 'not json');
      assert.strictEqual(readJsonSafe(join(tmpDir, 'bad.json')), null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns parsed object for valid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'readjson-'));
    try {
      writeFileSync(join(tmpDir, 'good.json'), JSON.stringify({ a: 1, b: 'hello' }));
      const result = readJsonSafe(join(tmpDir, 'good.json'));
      assert.notStrictEqual(result, null);
      assert.strictEqual(result!.a, 1);
      assert.strictEqual(result!.b, 'hello');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('tailFile', () => {
  it('returns empty string for missing file', () => {
    assert.strictEqual(tailFile('/nonexistent/path.log', 100), '');
  });

  it('returns last N bytes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tail-'));
    try {
      // 18 bytes: l,i,n,e,1,\n,l,i,n,e,2,\n,l,i,n,e,3,\n
      writeFileSync(join(tmpDir, 'test.log'), 'line1\nline2\nline3\n');
      const result = tailFile(join(tmpDir, 'test.log'), 10);
      // Last 10 bytes start at offset 8: 'ne2\nline3\n'
      assert.strictEqual(result, 'ne2\nline3\n');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns full file when smaller than maxBytes', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tail-'));
    try {
      writeFileSync(join(tmpDir, 'small.log'), 'hello world');
      const result = tailFile(join(tmpDir, 'small.log'), 100);
      assert.strictEqual(result, 'hello world');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('findRunDirByCallbackId', () => {
  it('returns null for empty CORTEX_RUN_DIR', () => {
    assert.strictEqual(findRunDirByCallbackId('dev:test:none'), null);
  });

  it('scans directories under CORTEX_RUN_DIR', () => {
    mkdirSync(CORTEX_RUN_DIR, { recursive: true });
    const dir1 = join(CORTEX_RUN_DIR, 'run-a');
    const dir2 = join(CORTEX_RUN_DIR, 'run-b');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, 'meta.json'), JSON.stringify({ callbackId: 'dev:run-a:none' }));
    writeFileSync(join(dir2, 'meta.json'), JSON.stringify({ callbackId: 'dev:run-b:task99' }));

    try {
      const found = findRunDirByCallbackId('dev:run-b:task99');
      assert.notStrictEqual(found, null);
      assert.ok(found!.endsWith('run-b'));

      const notFound = findRunDirByCallbackId('nonexistent');
      assert.strictEqual(notFound, null);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('tryUnlink', () => {
  it('removes existing file silently', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'unlink-'));
    try {
      const f = join(tmpDir, 'test.txt');
      writeFileSync(f, 'hello');
      assert.ok(existsSync(f));
      tryUnlink(f);
      assert.ok(!existsSync(f));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('no-ops on missing file', () => {
    tryUnlink('/nonexistent/path.txt'); // should not throw
  });
});

// ========================================================================
// handleCortexRunLaunch
// ========================================================================

describe('handleCortexRunLaunch', () => {
  let tempCwd: string;
  let spawnCalls: Array<{ cmd: string; args: string[]; opts: any }>;
  let callIdx: number;

  function makeMockSpawn(): (cmd: string, args: string[], opts: any) => { pid: number; unref: () => void } {
    return (cmd: string, args: string[], opts: any) => {
      spawnCalls.push({ cmd, args, opts });
      callIdx++;
      return { pid: 54321 + callIdx, unref: () => {} };
    };
  }

  before(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'launch-cwd-'));
  });

  after(() => {
    rmSync(tempCwd, { recursive: true, force: true });
  });

  beforeEach(() => {
    spawnCalls = [];
    callIdx = 0;
  });

  it('creates directory, writes meta.json, spawns watcher, writes pid, returns result', async () => {
    const params: CortexRunLaunchParams = {
      name: 'test-launch',
      command: ['echo', 'hello'],
      stall: '5m',
      gpu: 'none',
      cwd: tempCwd,
    };

    const result = await handleCortexRunLaunch(params, 'test-device', makeMockSpawn());

    assert.strictEqual(result.callbackId, 'test-device:test-launch:none');
    assert.ok(result.resultDir.endsWith('test-launch'));

    const runDir = result.resultDir;
    assert.ok(existsSync(runDir));

    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
    assert.strictEqual(meta.name, 'test-launch');
    assert.strictEqual(meta.callbackId, 'test-device:test-launch:none');
    assert.strictEqual(meta.device, 'test-device');
    assert.strictEqual(meta.stall, '5m');
    assert.strictEqual(meta.gpu, 'none');
    assert.deepStrictEqual(meta.command, ['echo', 'hello']);
    assert.ok(meta.startedAt);

    const pid = readFileSync(join(runDir, 'pid'), 'utf8').trim();
    assert.ok(pid.length > 0);

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].cmd, 'node');
    assert.ok(spawnCalls[0].args.includes('--name'));
    assert.ok(spawnCalls[0].args.includes('test-launch'));
    assert.ok(spawnCalls[0].args.includes('--state-dir'));
    assert.ok(spawnCalls[0].args.includes('--'));
    assert.ok(spawnCalls[0].args.includes('echo'));
    assert.ok(spawnCalls[0].args.includes('hello'));
    assert.strictEqual(spawnCalls[0].opts.detached, true);
    assert.strictEqual(spawnCalls[0].opts.stdio, 'ignore');
    assert.strictEqual(spawnCalls[0].opts.cwd, tempCwd);

    rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects existing dir without force', async () => {
    const mockSpawn = makeMockSpawn();
    const params: CortexRunLaunchParams = {
      name: 'existing-run',
      command: ['true'],
      cwd: tempCwd,
    };

    await handleCortexRunLaunch(params, 'dev', mockSpawn);
    await assert.rejects(() => handleCortexRunLaunch(params, 'dev', mockSpawn), /already exists/);

    rmSync(join(CORTEX_RUN_DIR, 'existing-run'), { recursive: true, force: true });
  });

  it('overwrites existing dir with force=true', async () => {
    const mockSpawn = makeMockSpawn();
    const params: CortexRunLaunchParams = {
      name: 'force-overwrite',
      command: ['true'],
      cwd: tempCwd,
      force: true,
    };

    await handleCortexRunLaunch(params, 'dev', mockSpawn);
    const r2 = await handleCortexRunLaunch(params, 'dev', mockSpawn);
    assert.ok(existsSync(r2.resultDir));
    assert.strictEqual(spawnCalls.length, 2);

    rmSync(join(CORTEX_RUN_DIR, 'force-overwrite'), { recursive: true, force: true });
  });

  it('rejects non-existent cwd', async () => {
    const params: CortexRunLaunchParams = {
      name: 'bad-cwd',
      command: ['true'],
      cwd: '/nonexistent/path/that/does/not/exist',
    };

    await assert.rejects(
      () => handleCortexRunLaunch(params, 'dev', makeMockSpawn()),
      /cwd does not exist/,
    );
  });
});

// ========================================================================
// handleCortexRunCancel
// ========================================================================

describe('handleCortexRunCancel', () => {
  beforeEach(() => {
    mkdirSync(CORTEX_RUN_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up dirs created during tests
    if (existsSync(CORTEX_RUN_DIR)) {
      for (const name of ['cancel-me', 'no-pid-file', 'dead-pid', 'sigterm-test']) {
        const d = join(CORTEX_RUN_DIR, name);
        if (existsSync(d)) rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('throws when run directory does not exist', async () => {
    await assert.rejects(() => handleCortexRunCancel({ name: 'nonexistent' }), /not found/);
  });

  it('throws when pid file does not exist', async () => {
    const dir = join(CORTEX_RUN_DIR, 'no-pid-file');
    mkdirSync(dir, { recursive: true });
    try {
      await assert.rejects(() => handleCortexRunCancel({ name: 'no-pid-file' }), /no live pid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns killed=false when pid is not alive', async () => {
    const dir = join(CORTEX_RUN_DIR, 'dead-pid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '99999999');
    try {
      const result = await handleCortexRunCancel({ name: 'dead-pid' });
      assert.strictEqual(result.killed, false);
      assert.strictEqual(result.pid, 99999999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends SIGTERM to process group', async () => {
    const dir = join(CORTEX_RUN_DIR, 'sigterm-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), String(process.pid));
    try {
      const killMock = mock.method(process, 'kill', () => true);
      try {
        const result = await handleCortexRunCancel({ name: 'sigterm-test' });
        assert.strictEqual(result.killed, true);
        assert.strictEqual(result.pid, process.pid);

        const killCalls = killMock.mock.calls;
        const actualKill = killCalls.find((c: any) => c.arguments[1] === 'SIGTERM');
        assert.ok(actualKill, 'expected a kill call with SIGTERM');
        assert.strictEqual(actualKill.arguments[0], -process.pid);
      } finally {
        killMock.mock.restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ========================================================================
// synthesizeOrphanResult
// ========================================================================

describe('synthesizeOrphanResult', () => {
  it('writes result.json with termination=orphaned and touches callback.pending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-'));
    try {
      writeFileSync(join(dir, 'output.log'), 'last line of output\n');
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ status: 'running', pid: 99999, started_at: '2026-01-01T00:00:00.000Z' }),
      );

      synthesizeOrphanResult(dir, { status: 'running', pid: 99999, started_at: '2026-01-01T00:00:00.000Z' });

      const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
      assert.strictEqual(result.termination, 'orphaned');
      assert.strictEqual(result.exit_code, -1);
      assert.strictEqual(result.last_output_line, 'last line of output');
      assert.ok(result.ended_at);

      assert.ok(existsSync(join(dir, 'callback.pending')));

      const updatedState = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      assert.strictEqual(updatedState.status, 'failed');
      assert.strictEqual(updatedState.termination, 'orphaned');
      assert.strictEqual(updatedState.exit_code, -1);
      assert.ok(updatedState.ended_at);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ========================================================================
// flushPendingCallbacks
// ========================================================================

describe('flushPendingCallbacks', () => {
  let sentMessages: string[];

  function createMockWs(open = true): any {
    return {
      send: (d: string) => { sentMessages.push(d); },
      readyState: open ? 1 : 3,
    };
  }

  function createRunDir(name: string, overrides?: any): string {
    const dir = join(CORTEX_RUN_DIR, name);
    mkdirSync(dir, { recursive: true });

    const opts = {
      termination: 'completed',
      exitCode: 0,
      callbackId: `dev:${name}:none`,
      taskProject: null,
      taskId: null,
      dispatchGeneration: null,
      logTailBytes: 4096,
      logContent: 'test output line 1\ntest output line 2\n',
      status: 'completed',
      pid: 12345,
      hasPending: true,
      hasMeta: true,
      hasResult: true,
      hasState: true,
      hasLog: true,
      ...overrides,
    };

    if (opts.hasMeta) {
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        name, callbackId: opts.callbackId, taskProject: opts.taskProject,
        taskId: opts.taskId, dispatchGeneration: opts.dispatchGeneration,
        logTailBytes: opts.logTailBytes, command: ['echo', 'hello'],
      }));
    }

    if (opts.hasResult) {
      writeFileSync(join(dir, 'result.json'), JSON.stringify({
        termination: opts.termination, exit_code: opts.exitCode,
        started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T01:00:00.000Z',
        duration_seconds: 3600, duration_human: '1h', last_output_line: 'test output line 2',
        gpu: opts.gpu ?? null,
      }));
    }

    if (opts.hasState) {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        status: opts.status, pid: opts.pid, started_at: '2026-01-01T00:00:00.000Z',
      }));
    }

    if (opts.hasLog) {
      writeFileSync(join(dir, 'output.log'), opts.logContent);
    }

    if (opts.hasPending) {
      writeFileSync(join(dir, 'callback.pending'), '');
    }

    return dir;
  }

  beforeEach(() => {
    sentMessages = [];
    mkdirSync(CORTEX_RUN_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(CORTEX_RUN_DIR)) {
      rmSync(CORTEX_RUN_DIR, { recursive: true, force: true });
    }
  });

  it('sends task-callback message for dir with callback.pending', async () => {
    createRunDir('test-run-1');
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');

    assert.strictEqual(sentMessages.length, 1);
    const msg = JSON.parse(sentMessages[0]);
    assert.strictEqual(msg.type, 'task-callback');
    assert.strictEqual(msg.device, 'test-device');
    assert.strictEqual(msg.callbackId, 'dev:test-run-1:none');
    assert.strictEqual(msg.termination, 'completed');
    assert.strictEqual(msg.exitCode, 0);
    assert.ok(msg.logTail);
  });

  it('round-trips dispatch generation from durable metadata into the callback payload', async () => {
    createRunDir('generation-run', {
      taskProject: 'atlas', taskId: 'a223', dispatchGeneration: 'generation-b',
    });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');

    assert.strictEqual(sentMessages.length, 1);
    const msg = JSON.parse(sentMessages[0]);
    assert.strictEqual(msg.dispatchGeneration, 'generation-b');
  });

  it('carries the resolved gpu from result.json into the callback payload', async () => {
    createRunDir('gpu-run', { gpu: { indices: [1], memoryMb: 49140 } });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');

    assert.strictEqual(sentMessages.length, 1);
    const msg = JSON.parse(sentMessages[0]);
    assert.deepStrictEqual(msg.gpu, { indices: [1], memoryMb: 49140 });
  });

  it('sends gpu:null when result.json has no gpu', async () => {
    createRunDir('no-gpu-run', { gpu: null });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');

    const msg = JSON.parse(sentMessages[0]);
    assert.strictEqual(msg.gpu, null);
  });

  it('sends task-callback for each pending dir', async () => {
    createRunDir('run-a');
    createRunDir('run-b');
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');

    assert.strictEqual(sentMessages.length, 2);
    const ids = sentMessages.map((m: string) => JSON.parse(m).callbackId).sort();
    assert.deepStrictEqual(ids, ['dev:run-a:none', 'dev:run-b:none']);
  });

  it('skips dirs without callback.pending (non-orphan)', async () => {
    createRunDir('no-pending', { hasPending: false, status: 'completed' });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');
    assert.strictEqual(sentMessages.length, 0);
  });

  it('skips dirs without callback.pending when state=running and pid alive', async () => {
    createRunDir('still-running', { hasPending: false, status: 'running', pid: process.pid });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');
    assert.strictEqual(sentMessages.length, 0);
  });

  it('detects orphan and sends callback when state=running but pid dead', async () => {
    createRunDir('orphan-run', {
      hasPending: false, status: 'running', pid: 99999999,
      hasResult: false, termination: undefined, exitCode: undefined,
    });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');

    assert.strictEqual(sentMessages.length, 1);
    const msg = JSON.parse(sentMessages[0]);
    assert.strictEqual(msg.termination, 'orphaned');
    assert.strictEqual(msg.exitCode, -1);

    const runDir = join(CORTEX_RUN_DIR, 'orphan-run');
    assert.ok(existsSync(join(runDir, 'callback.pending')));
    assert.ok(existsSync(join(runDir, 'result.json')));
  });

  it('does nothing when WS is not open', async () => {
    createRunDir('test-run-2');
    const ws = createMockWs(false);
    await flushPendingCallbacks(ws, 'test-device');
    assert.strictEqual(sentMessages.length, 0);
  });

  it('does nothing when CORTEX_RUN_DIR does not exist', async () => {
    rmSync(CORTEX_RUN_DIR, { recursive: true, force: true });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');
    assert.strictEqual(sentMessages.length, 0);
  });

  it('skips dir with orphan but still running pid', async () => {
    createRunDir('actually-running', {
      hasPending: false, status: 'running', pid: process.pid, hasResult: false,
    });
    const ws = createMockWs();
    await flushPendingCallbacks(ws, 'test-device');
    assert.strictEqual(sentMessages.length, 0);
  });
});

// ========================================================================
// Ack integration
// ========================================================================

describe('ack integration', () => {
  beforeEach(() => {
    mkdirSync(CORTEX_RUN_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(CORTEX_RUN_DIR)) {
      rmSync(CORTEX_RUN_DIR, { recursive: true, force: true });
    }
  });

  it('finds run dir and removes callback.pending on ack', () => {
    createRunDir('ack-test', { callbackId: 'dev:ack-test:task1' });

    const dir = findRunDirByCallbackId('dev:ack-test:task1');
    assert.notStrictEqual(dir, null);

    const pendingPath = join(dir!, 'callback.pending');
    assert.ok(existsSync(pendingPath));
    tryUnlink(pendingPath);
    assert.ok(!existsSync(pendingPath));
  });

  it('leaves callback.pending intact when ack is not ok', () => {
    createRunDir('nack-test', { callbackId: 'dev:nack-test:task1' });

    const dir = findRunDirByCallbackId('dev:nack-test:task1');
    assert.notStrictEqual(dir, null);

    const pendingPath = join(dir!, 'callback.pending');
    assert.ok(existsSync(pendingPath));
    // Marker stays — no tryUnlink call on nack
  });
});

// ========================================================================
// Helper for createRunDir in ack tests
// ========================================================================

function createRunDir(name: string, overrides?: any): string {
  const dir = join(CORTEX_RUN_DIR, name);
  mkdirSync(dir, { recursive: true });

  const opts = {
    callbackId: `dev:${name}:none`,
    ...overrides,
  };

  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ callbackId: opts.callbackId, name }));
  writeFileSync(join(dir, 'callback.pending'), '');
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ termination: 'completed', exit_code: 0 }));
  return dir;
}
