// input:  PI adapter with fake process and delayed provider scan
// output: fresh-spawn latency and event-loop ordering measurements
// pos:    Focused benchmark for non-blocking PI provider discovery
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';

interface StubChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
}

function makeStubChild(): StubChild {
  const child = new EventEmitter() as StubChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function awaitDiscovery(completion: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error('provider discovery benchmark timed out')), timeoutMs);
  });
  try {
    await Promise.race([completion, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ARTIFICIAL_DISCOVERY_MS = 250;
const DISCOVERY_TIMEOUT_MS = 1_000;
const SPAWN_COUNT = 5;
const benchmarkHome = mkdtempSync(join(tmpdir(), 'cortex-pi-discovery-benchmark-'));
const previousHome = process.env.HOME;
const previousCortexHome = process.env.CORTEX_HOME;
process.env.HOME = benchmarkHome;
process.env.CORTEX_HOME = benchmarkHome;
mkdirSync(join(benchmarkHome, 'config'), { recursive: true });

const children: StubChild[] = [];
const processes: Array<{ close: () => Promise<void> }> = [];
let resetSettings: (() => void) | null = null;

try {
  const [
    { PIAdapter },
    { createPIProviderDiscovery },
    { PI_MODELS_PATH },
    { resetSettingsForTests },
  ] = await Promise.all([
    import('../src/agent-adapter/pi/adapter.js'),
    import('../src/agent-adapter/pi/discovery.js'),
    import('../src/agent-adapter/pi/agent-dir.js'),
    import('../src/core/settings.js'),
  ]);
  resetSettings = resetSettingsForTests;
  let scans = 0;
  let discoverySettled = false;
  let finishDiscovery!: () => void;
  const discoveryFinished = new Promise<void>((resolve) => { finishDiscovery = resolve; });
  const discovery = createPIProviderDiscovery({
    scan: async () => {
      scans += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, ARTIFICIAL_DISCOVERY_MS));
      discoverySettled = true;
      finishDiscovery();
      return ['anthropic', 'openai-codex'];
    },
  });
  const spawner = (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    const child = makeStubChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const adapter = new PIAdapter(spawner, join(benchmarkHome, 'sessions'), discovery);
  processes.push(adapter.spawn({
    sessionId: null,
    sessionKey: 'benchmark-warmup',
    resume: false,
  }));
  const durations: number[] = [];
  const timerStartedAt = performance.now();
  const timer = new Promise<number>((resolve) => {
    setTimeout(() => resolve(performance.now() - timerStartedAt), 0);
  });

  for (let index = 0; index < SPAWN_COUNT; index += 1) {
    const startedAt = performance.now();
    processes.push(adapter.spawn({
      sessionId: null,
      sessionKey: `benchmark-${index}`,
      resume: false,
      model: 'claude-sonnet-4-6',
      piProvider: 'anthropic',
      piGatewayBaseUrl: 'http://127.0.0.1:9880',
      piGatewayPath: '/m/default/anthropic',
    }));
    durations.push(performance.now() - startedAt);
    const models = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'));
    assert.equal(models.providers.anthropic.baseUrl, 'http://127.0.0.1:9880/m/default/anthropic');
  }

  const timerLagMs = await timer;
  const maxSpawnMs = Math.max(...durations);
  const timerAdvancedBeforeDiscovery = !discoverySettled;
  assert.equal(children.length, SPAWN_COUNT + 1);
  assert.equal(scans, 1, 'multiple fresh spawns must coalesce discovery');
  assert.ok(maxSpawnMs < ARTIFICIAL_DISCOVERY_MS, 'spawn must return before slow discovery');
  assert.equal(timerAdvancedBeforeDiscovery, true, 'event loop must advance before discovery settles');

  await awaitDiscovery(discoveryFinished, DISCOVERY_TIMEOUT_MS);
  const totalDiscoveryMs = performance.now() - timerStartedAt;
  const result = {
    artificialDiscoveryMs: ARTIFICIAL_DISCOVERY_MS,
    spawnCount: SPAWN_COUNT,
    discoveryCalls: scans,
    maxSpawnMs: Number(maxSpawnMs.toFixed(3)),
    meanSpawnMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(3)),
    timerLagMs: Number(timerLagMs.toFixed(3)),
    timerAdvancedBeforeDiscovery,
    totalDiscoveryMs: Number(totalDiscoveryMs.toFixed(3)),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  for (const child of children) child.emit('close', 0, null);
  await Promise.all(processes.map((agentProcess) => agentProcess.close()));
  resetSettings?.();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousCortexHome === undefined) delete process.env.CORTEX_HOME;
  else process.env.CORTEX_HOME = previousCortexHome;
  rmSync(benchmarkHome, { recursive: true, force: true });
}
