// input:  PIAdapter stub + runWithAdapter + cost-tracker
// output: agent_end → cost entry integration test
// pos:    PI cost record end-to-end integration path
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import { _test as modeManagerTest } from '../src/domain/agents/index.js';
import type { AgentAdapter } from '../src/agent-adapter/index.js';
import { CAPABILITIES_BY_BACKEND } from '../src/agent-adapter/index.js';
import type { AgentSpawnConfig } from '../src/agent-adapter/types.js';
import type { CostEntry } from '../src/domain/costs/cost-tracker.js';
import { costRepo } from '../src/store/cost-repo.js';

const { runWithAdapter } = modeManagerTest;

// Temp session dir (isolated per test run)
const SESSION_DIR = pathJoin(tmpdir(), `pi-cost-record-test-${process.pid}`);
mkdirSync(SESSION_DIR, { recursive: true });

// Temp costs file (isolated from production costs.json)
const COSTS_FILE = pathJoin(tmpdir(), `pi-cost-record-costs-${process.pid}.json`);
const ORIGINAL_COSTS_FILE = process.env['CORTEX_COSTS_FILE'];

// --- Stub child process infrastructure (mirrors agent-adapter-pi-tool-shims.test.ts) ---

interface StubChild extends EventEmitter {
  stdin: PassThrough & { writeHistory: string[] };
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  __killed: boolean;
}

function makeStubChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  const stdin = new PassThrough() as PassThrough & { writeHistory: string[] };
  stdin.writeHistory = [];
  const origWrite = stdin.write.bind(stdin);
  (stdin as any).write = (chunk: unknown, ...rest: unknown[]) => {
    const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    stdin.writeHistory.push(s);
    return origWrite(chunk as any, ...(rest as any));
  };
  emitter.stdin = stdin;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.__killed = false;
  emitter.kill = (_signal?: NodeJS.Signals | number) => {
    if (emitter.__killed) return false;
    emitter.__killed = true;
    return true;
  };
  return emitter;
}

function makeStubSpawner(): {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  children: StubChild[];
} {
  const children: StubChild[] = [];
  return {
    children,
    spawn: (_cmd, _args, _opts) => {
      const child = makeStubChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
  };
}

function pushLine(child: StubChild, obj: unknown): void {
  child.stdout.write(JSON.stringify(obj) + '\n');
}

// --- Cleanup (N2H-3: afterAll() ensures env is restored even on assertion failure) ---

afterAll(() => {
  if (ORIGINAL_COSTS_FILE !== undefined) {
    process.env['CORTEX_COSTS_FILE'] = ORIGINAL_COSTS_FILE;
  } else {
    delete process.env['CORTEX_COSTS_FILE'];
  }
  if (existsSync(COSTS_FILE)) {
    unlinkSync(COSTS_FILE);
  }
  // Reset the singleton so the next test file gets a clean state
  costRepo._testReset();
});

// ---------------------------------------------------------------------------
// Integration test: direct-pi run → cost entry with provider/model/tokens
// ---------------------------------------------------------------------------

test('pi-cost-record: agent_end with provider+model+usage → cost entry in costs file', async () => {
  // Redirect cost tracking to isolated temp file
  process.env['CORTEX_COSTS_FILE'] = COSTS_FILE;
  costRepo._testReset();

  const s = makeStubSpawner();
  const piAdapter = new PIAdapter(s.spawn, SESSION_DIR);

  // Wrap PIAdapter as AgentAdapter for runWithAdapter
  const adapter: AgentAdapter = {
    backend: 'pi',
    capabilities: CAPABILITIES_BY_BACKEND['pi'],
    spawn: (config: AgentSpawnConfig) => piAdapter.spawn(config),
    close: (key: string) => piAdapter.close(key),
    kill: (key: string) => piAdapter.kill(key),
    listSessions: () => piAdapter.listSessions(),
  };

  // runWithAdapter calls adapter.spawn() synchronously inside, creating s.children[0].
  const handle = runWithAdapter(
    adapter,
    'hello',
    { project: 'pi-cost-test', trigger: 'test' },
    { model: '', backend: 'pi', mode: 'api' },
    undefined,
  );

  // After runWithAdapter() returns synchronously (handle is returned immediately),
  // the spawn has happened and s.children[0] is available.
  const child = s.children[0];
  assert.ok(child, 'stub child should exist after runWithAdapter');

  // Emit bootstrap response to unblock session_started processing.
  pushLine(child, {
    type: 'response', id: 'bootstrap', command: 'get_state', success: true,
    data: { sessionId: 'pi-test-001' },
  });
  await Promise.resolve();
  await Promise.resolve();

  // Emit agent_end with provider, model, and usage (non-zero cost).
  // This triggers cost_record + turn_complete events in the event parser.
  pushLine(child, {
    type: 'agent_end',
    messages: [
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-4',
        usage: { input: 200, output: 100, cost: { total: 0.005 } },
      },
    ],
  });
  await Promise.resolve();
  await Promise.resolve();

  // Signal clean subprocess exit.
  child.emit('close', 0);

  // Wait for runWithAdapter to finish processing.
  await handle.promise;
  // Drain any pending async cost writes (recordCost is fire-and-forget in mode-manager event loop).
  await costRepo.flush();

  // --- Assertions ---

  assert.ok(existsSync(COSTS_FILE), 'costs file should exist after cost_record was processed');
  const raw = readFileSync(COSTS_FILE, 'utf8');
  const lines = raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l) as CostEntry);
  assert.ok(lines.length > 0, 'costs file should have at least one entry (JSONL format)');
  const piEntries = lines.filter(e => e.backend === 'pi');
  assert.equal(piEntries.length, 1, 'exactly one PI cost entry should be recorded (no double-recording)');

  const entry = piEntries[0];
  assert.equal(entry.backend, 'pi', 'backend should be pi');
  assert.equal(entry.provider, 'anthropic', 'provider should be anthropic');
  assert.equal(entry.model, 'claude-opus-4', 'model should match agent_end message');
  assert.equal(entry.input_tokens, 200, 'input_tokens should match usage.input');
  assert.equal(entry.output_tokens, 100, 'output_tokens should match usage.output');
  assert.ok(
    Math.abs((entry.cost_usd ?? 0) - 0.005) < 0.0001,
    `cost_usd should be ~0.005, got ${entry.cost_usd}`,
  );
  assert.equal(entry.project, 'pi-cost-test', 'project should match runWithAdapter options');
  assert.equal(entry.trigger, 'test', 'trigger should match runWithAdapter options');
});
