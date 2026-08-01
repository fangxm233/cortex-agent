// input:  pinned launcher, C8 probe, fake agents and supervisors
// output: one-step and full-run process isolation proofs
// pos:    Process integration test for benchmark local threads
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeAll, beforeEach, it } from 'vitest';
import {
  formatAccessProbeSummary,
  runNodeAccessProbe,
} from '../../../src/domain/agent-run/access-probe.js';
import { validateTrajectoryLifecycle } from '../../../src/domain/agent-run/manifest.js';
import {
  preparePinnedTrialPaths,
  spawnPinnedNode,
} from '../../../src/domain/agent-run/pinned-node-process.js';

const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx');
const entry = fileURLToPath(new URL('./benchmark-local-thread-entry.ts', import.meta.url));
const fullProbeEntry = fileURLToPath(
  new URL('./full-benchmark-thread-probe-entry.mjs', import.meta.url),
);
const register = fileURLToPath(new URL('./fake-run-agent-register.mjs', import.meta.url));
const fakeSupervisor = fileURLToPath(new URL('./fake-supervisor.ts', import.meta.url));
const installRoot = fileURLToPath(new URL('../../../', import.meta.url));
const realSupervisor = fileURLToPath(
  new URL('../../../native/cortex-supervisor/dist/cortex-supervisor', import.meta.url),
);
let root = '';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seedConfig(cortexHome: string): void {
  writeJson(path.join(cortexHome, 'config/profiles.json'), {
    defaultProfile: 'fixture',
    profiles: {
      fixture: {
        model: 'fixture-model', backend: 'claude', claudeBackend: 'print',
        provider: 'anthropic', fallback: [],
      },
    },
  });
  const base = path.join(cortexHome, 'config/thread-templates');
  writeJson(path.join(base, 'agents/benchmark-coder.json'), {
    name: 'benchmark-coder', profile: '__active__', persistSession: false,
    directive: 'fixture', systemPrompt: 'fixture', promptTemplate: '{{input}}',
    tools: 'Read,Write', pluginDirs: [],
  });
  writeJson(path.join(base, 'templates/fixture.json'), {
    name: 'fixture', description: 'fixture', agents: ['benchmark-coder'],
    transitions: [], entryAgent: 'benchmark-coder', maxTotalSteps: 1, disableHooks: true,
  });
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
}

function waitForExit(child: ReturnType<typeof spawnPinnedNode>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function installSupervisor(file: string): void {
  const compiled = `${file}.mjs`;
  const output = ts.transpileModule(fs.readFileSync(fakeSupervisor, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  fs.writeFileSync(compiled, output);
  fs.writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(compiled)} "$@"\n`, {
    mode: 0o755,
  });
}

interface ProcessFixture {
  workspace: string;
  outputFile: string;
  requestFile: string;
  supervisor: string;
  tsconfig: string;
}

function writeTsconfig(file: string): void {
  writeJson(file, {
    compilerOptions: {
      baseUrl: path.resolve('.'),
      paths: {
        '@core/*': ['src/core/*'], '@store/*': ['src/store/*'],
        '@events/*': ['src/events/*'], '@domain/*': ['src/domain/*'],
        '@platform/*': ['src/platform/*'], '@orch/*': ['src/orchestration/*'],
        '@entry/*': ['src/entry/*'],
      },
    },
  });
}

function prepareFixture(): ProcessFixture {
  const paths = preparePinnedTrialPaths(root);
  seedConfig(paths.cortexHome);
  const workspace = path.join(root, 'workspace');
  const trajectoryRoot = path.join(root, 'trajectory');
  const fixture = {
    workspace, outputFile: path.join(root, 'output.json'),
    requestFile: path.join(root, 'request.json'),
    supervisor: path.join(root, 'cortex-supervisor'),
    tsconfig: path.join(root, 'tsx-tsconfig.json'),
  };
  fs.mkdirSync(workspace);
  fs.mkdirSync(trajectoryRoot);
  installSupervisor(fixture.supervisor);
  writeTsconfig(fixture.tsconfig);
  writeJson(fixture.requestFile, {
    workspaceCwd: workspace, template: 'fixture', instruction: 'fixture task',
    profileName: 'fixture', rootRunId: 'fresh-process', trajectoryRoot,
    limits: { maxSteps: 1, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
  });
  return fixture;
}

async function runFixture(fixture: ProcessFixture): Promise<any> {
  const child = spawnPinnedNode({
    trialRoot: root, workspaceCwd: fixture.workspace, entry,
    args: [fixture.requestFile, fixture.outputFile],
    nodeArgs: ['--import', tsx, '--import', register],
    parentEnv: {
      CORTEX_SUPERVISOR_BINARY: fixture.supervisor,
      TSX_TSCONFIG_PATH: fixture.tsconfig,
    },
    passthroughEnv: ['CORTEX_SUPERVISOR_BINARY', 'TSX_TSCONFIG_PATH'],
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  assert.equal(await waitForExit(child), 0, stderr);
  return JSON.parse(fs.readFileSync(fixture.outputFile, 'utf8'));
}

function assertPinnedResult(value: any, workspace: string): void {
  assert.equal(value.result.state, 'completed');
  assert.equal(value.threadCount, 1);
  assert.equal(value.busIsNull, true);
  assert.equal(value.listeningSocket, false);
  assert.deepEqual(value.childPids, []);
  assert.equal(value.cwd, workspace);
  assert.equal(value.invocations.length, 1);
  assert.equal(value.invocations[0].cwd, workspace);
  assert.equal(value.argv.some((arg: string) => /entry\/(?:app|daemon)\./.test(arg)), false);
  assert.deepEqual(value.paths, {
    CONFIG_DIR: path.join(root, 'cortex-home/config'),
    DATA_DIR: path.join(root, 'cortex-home'),
    PROJECTS_DIR: path.join(root, 'projects'),
    STORE_DIR: path.join(root, 'cortex-home/data'),
    WORKSPACE_DIR: path.join(root, 'cortex-home/tmp'),
  });
  assert.deepEqual(value.storeFiles, [
    'executions.json', 'fake-run-agent.jsonl', 'session-registry.json', 'threads.json',
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'projects')), []);
}

async function runFullProbe(workspace: string, trialRoot: string) {
  return runNodeAccessProbe({
    trialRoot,
    workspaceCwd: workspace,
    entry: fullProbeEntry,
    args: [realSupervisor],
    parentEnv: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    installRoot,
    hostHome: os.homedir(),
    hostCortexHome: path.join(os.homedir(), '.cortex'),
    supervisorBinary: realSupervisor,
    timeoutMs: 60_000,
  });
}

function assertFullProbeReceipt(trialRoot: string): void {
  const receipt = JSON.parse(fs.readFileSync(
    path.join(trialRoot, 'logs/full-benchmark-thread-receipt.json'), 'utf8',
  ));
  assert.equal(receipt.result.state, 'completed');
  assert.equal(receipt.result.steps, 4);
  assert.equal(receipt.invocations, 4);
  assert.deepEqual(validateTrajectoryLifecycle({
    trajectoryRoot: path.join(trialRoot, 'cortex-home/tmp/trajectory'),
    rootRunId: 'full-benchmark-thread-probe',
    threadId: receipt.result.threadId,
  }), { ok: true, problems: [] });
  assert.equal(receipt.manifestState, 'completed');
}

beforeAll(() => {
  const built = spawnSync('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ], { cwd: installRoot, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-thread-process-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it('runs exactly one fake benchmark thread inside the path-pinned fresh process', async () => {
  const fixture = prepareFixture();
  assertPinnedResult(await runFixture(fixture), fixture.workspace);
}, 45_000);

it('keeps a complete four-step orchestrator run inside the unchanged C8 boundary', async () => {
  const workspace = path.join(root, 'probe-workspace');
  const trialRoot = path.join(root, 'probe-trial');
  fs.mkdirSync(workspace);
  const verdict = await runFullProbe(workspace, trialRoot);
  assert.equal(verdict.ok, true, formatAccessProbeSummary(verdict));
  assert.deepEqual(verdict.violations, []);
  assertFullProbeReceipt(trialRoot);
}, 75_000);
