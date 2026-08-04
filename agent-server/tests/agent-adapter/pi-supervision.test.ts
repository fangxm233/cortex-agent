// input:  a PI adapter, a supervising spawner and a spawn config
// output: proof that PI carries the supervision handle and reads the spawn config
// pos:    Regression suite for design §13 P1 (i) source and (ii) type
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { it } from 'vitest';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import type {
  AgentProcessSpawner, AgentProcessSupervision, SpawnedAgentProcess,
} from '../../src/agent-adapter/types.js';

const SESSION_DIR = join(tmpdir(), `pi-supervision-${process.pid}`);
mkdirSync(SESSION_DIR, { recursive: true });

function stubChild(): any {
  const child: any = new EventEmitter();
  child.pid = 9931;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (): boolean => true;
  return child;
}

function supervisionHandle(): AgentProcessSupervision {
  return {
    started: Promise.resolve({ pid: 9931, pgid: 9931 }),
    exited: Promise.resolve({ code: 0, signal: null }),
    quiescent: Promise.resolve(),
    closed: Promise.resolve({ code: 0, signal: null }),
    cancel: () => {},
    dispose: async () => {},
  };
}

interface Recorder {
  calls: { command: string; args: string[] }[];
  spawner: AgentProcessSpawner;
  supervision: AgentProcessSupervision;
}

function recordingSpawner(): Recorder {
  const calls: { command: string; args: string[] }[] = [];
  const supervision = supervisionHandle();
  return {
    calls,
    supervision,
    spawner: (command, args) => {
      calls.push({ command, args });
      return { process: stubChild(), supervision } as unknown as SpawnedAgentProcess;
    },
  };
}

// --- P1 (ii): the widened SpawnFn keeps the supervision handle reachable ---

it('surfaces the supervision handle the spawner returned', async () => {
  const supervising = recordingSpawner();
  const adapter = new PIAdapter(supervising.spawner, SESSION_DIR);
  const proc = adapter.spawn({
    sessionId: null, sessionKey: 'pi-supervised', resume: false, cwd: SESSION_DIR,
  });
  assert.equal(proc.supervision, supervising.supervision);
  assert.deepEqual(await proc.supervision!.started, { pid: 9931, pgid: 9931 });
  await proc.supervision!.quiescent;
  proc.kill();
});

it('leaves supervision undefined for an unsupervised spawn', () => {
  const adapter = new PIAdapter(() => ({ process: stubChild() } as unknown as SpawnedAgentProcess), SESSION_DIR);
  const proc = adapter.spawn({
    sessionId: null, sessionKey: 'pi-unsupervised', resume: false, cwd: SESSION_DIR,
  });
  assert.equal(proc.supervision, undefined);
  proc.kill();
});

// --- P1 (i): the spawn config is the source, exactly as Claude's path is ---

it('spawns through spawnConfig.processSpawner rather than the constructor seam', () => {
  const constructorSeam = recordingSpawner();
  const injected = recordingSpawner();
  const adapter = new PIAdapter(constructorSeam.spawner, SESSION_DIR);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'pi-config-spawner',
    resume: false,
    cwd: SESSION_DIR,
    processSpawner: injected.spawner,
  });
  assert.equal(injected.calls.length, 1);
  assert.equal(constructorSeam.calls.length, 0);
  assert.equal(proc.supervision, injected.supervision);
  proc.kill();
});

it('falls back to the constructor seam only when the config carries no spawner', () => {
  const constructorSeam = recordingSpawner();
  const adapter = new PIAdapter(constructorSeam.spawner, SESSION_DIR);
  const proc = adapter.spawn({
    sessionId: null, sessionKey: 'pi-constructor-spawner', resume: false, cwd: SESSION_DIR,
  });
  assert.equal(constructorSeam.calls.length, 1);
  proc.kill();
});

// --- P2: the frozen CLI path replaces the bare `pi` literal ---

it('runs the CLI path the spawn config pins', () => {
  const recorder = recordingSpawner();
  const adapter = new PIAdapter(recorder.spawner, SESSION_DIR);
  const proc = adapter.spawn({
    sessionId: null,
    sessionKey: 'pi-cli-path',
    resume: false,
    cwd: SESSION_DIR,
    cliPath: '/pinned/bundle/pi',
  });
  assert.equal(recorder.calls[0].command, '/pinned/bundle/pi');
  proc.kill();
});

it('resolves `pi` from PATH when no CLI path is pinned', () => {
  const recorder = recordingSpawner();
  const adapter = new PIAdapter(recorder.spawner, SESSION_DIR);
  const proc = adapter.spawn({
    sessionId: null, sessionKey: 'pi-default-cli', resume: false, cwd: SESSION_DIR,
  });
  assert.equal(recorder.calls[0].command, 'pi');
  proc.kill();
});
