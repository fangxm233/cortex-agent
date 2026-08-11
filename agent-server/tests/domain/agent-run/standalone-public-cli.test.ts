// input:  packed CLI, Claude/PI fakes and hostile descendants
// output: exact-public state handoff, credential and process containment
// pos:    Packed cortex agent-run standalone regression
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, it } from 'vitest';

const serverRoot = path.resolve('.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-public-cli-'));
let installed: PackedBundle;
let hostileHelper = '';

function run(command: string, args: string[], timeout = 240_000) {
  return spawnSync(command, args, {
    cwd: serverRoot, encoding: 'utf8', timeout,
  });
}

beforeAll(() => {
  const native = run('flock', [
    '-x', '/tmp/cortex-supervisor-build.lock', 'npm', 'run', 'build:supervisor',
  ]);
  assert.equal(native.status, 0, `${native.stdout}\n${native.stderr}`);
  const built = run('npm', ['run', 'build']);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  installed = installPackedBundle();
  hostileHelper = path.join(root, 'refork-grandchild');
  const compiled = run('gcc', [
    '-std=c11', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror',
    path.join(serverRoot, 'tests/native/fixtures/refork-grandchild.c'), '-o', hostileHelper,
  ]);
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
}, 480_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

function fakeBackend(base = root): { cli: string; observation: string } {
  const observation = path.join(base, 'backend-observation.json');
  const script = write(path.join(base, 'bundle', 'fake-claude.mjs'), `
import fs from 'node:fs';
import { createInterface } from 'node:readline';
fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ env: process.env }));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', (line) => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ type: 'stream_event', event: {
    type: 'message_start', message: { model: 'fake-claude', usage: {
      input_tokens: 10, output_tokens: 2,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    } },
  } }));
  console.log(JSON.stringify({ type: 'assistant', message: {
    id: 'assistant-1', model: 'fake-claude',
    content: [{ type: 'text', text: 'done' }],
  } }));
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id, result: 'done', num_turns: 1,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 2,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
  lines.close();
});
`);
  const cli = write(
    path.join(base, 'bundle', 'claude'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    0o755,
  );
  return { cli, observation };
}

function tamperStateAdmissionAfterTerminal(base: string): string {
  const marker = path.join(base, 'admission-tampered');
  return write(path.join(base, 'tamper-state-admission.cjs'), `
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const renameSync = fs.renameSync;
fs.renameSync = function (source, target) {
  renameSync(source, target);
  if (!target.endsWith('.terminal.json') || !path.basename(target).startsWith('run-')) return;
  const terminal = JSON.parse(fs.readFileSync(target, 'utf8'));
  const journalPath = path.resolve(path.dirname(target), terminal.journal_path);
  const records = fs.readFileSync(journalPath, 'utf8').trimEnd().split('\\n')
    .map(line => JSON.parse(line)).filter(record => record.type !== 'state_admission');
  records.slice(1).forEach((record, index) => { record.seq = index + 1; });
  const bytes = records.map(record => JSON.stringify(record)).join('\\n') + '\\n';
  fs.writeFileSync(journalPath, bytes);
  terminal.journal_sha256 = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(target, JSON.stringify(terminal) + '\\n');
  fs.writeFileSync(${JSON.stringify(marker)}, '');
};
`);
}

function armResolution(
  cli: string,
  bundleRoot: string,
  base = root,
  trialId = 'trial-public-cli',
  backend: 'claude' | 'pi' = 'claude',
): string {
  const defaults = path.join(bundleRoot, 'defaults');
  const pi = backend === 'pi';
  const document = {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2', kind: 'cortex',
      name: pi ? 'cortex-pi-direct' : 'cortex-direct',
      backend, provider: 'anthropic', model: pi ? 'pi-trial-model' : 'claude-sonnet',
      credential_capability: pi ? 'pi-api-key' : 'claude-api-key',
      orchestration: { mode: 'direct', ask_manager: false },
      limits: {
        max_thread_starts: 0, max_parent_questions: 0, max_task_depth: 0, max_tasks: 0,
        max_provider_requests: 4, max_resident_agent_processes: 1,
        max_cost_usd: '1.00', deadline_seconds: 30,
      },
    },
    arm_path: pi ? 'arm://cortex-pi-direct' : 'arm://cortex-direct', trial_id: trialId,
    root_run_id: `${trialId}.${pi ? 'cortex-pi-direct' : 'cortex-direct'}`,
    task: { task_id: `task-${trialId}`, image_ref: 'image@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}` },
    profile_name: 'benchmark', paid_run: false,
    pi_benchmark_capability_proven: pi || undefined,
    credential_capabilities: [{
      id: pi ? 'pi-api-key' : 'claude-api-key', state: 'offline-contract-passed',
      key: { runner_or_backend: backend, provider: 'anthropic',
        protocol: 'anthropic-messages', credential_kind: 'api-key-bearer',
        proxy_adapter_version: 'fixture/1' },
    }],
    credential: { upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com', proxy_base_url: 'http://127.0.0.1:1',
      dummy_token_ref: 'offline-token' },
    cli_artifact: { path: cli, version: 'fixture-1' },
    model_alias_policy: { kind: 'exact' },
    roles: { parent: {
      system_prompt_path: path.join(defaults, 'prompts/systemPrompts/direct.md'),
      directive_path: path.join(defaults, 'prompts/directives/executor.md'),
      tools: pi ? ['read', 'write'] : ['Read', 'Write'],
      plugin_dirs: [], mcp_composition: 'none',
      mcp_config_paths: [], disable_hooks: true,
    } },
    thread_templates: {}, thread_agents: {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
  return write(path.join(base, 'agent', 'arm-resolution.json'), JSON.stringify(document));
}

interface PackedBundle {
  root: string;
  cortex: string;
  supervisor: string;
}

function installPackedBundle(): PackedBundle {
  const destination = path.join(root, 'packed');
  fs.mkdirSync(destination, { recursive: true });
  const packed = run('npm', ['pack', '--ignore-scripts', '--pack-destination', destination]);
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const tarball = path.join(destination, packed.stdout.trim().split('\n').at(-1) as string);
  const extracted = path.join(root, 'installed');
  fs.mkdirSync(extracted);
  const untarred = run('tar', ['-xzf', tarball, '-C', extracted]);
  assert.equal(untarred.status, 0, untarred.stderr);
  const bundleRoot = path.join(extracted, 'package');
  const bundledModules = path.join(bundleRoot, 'node_modules');
  fs.rmSync(bundledModules, { recursive: true, force: true });
  fs.symlinkSync(path.resolve(serverRoot, '..', 'node_modules'), bundledModules);
  const bin = path.join(extracted, 'bin');
  fs.mkdirSync(bin);
  const cortex = path.join(bin, 'cortex');
  fs.symlinkSync(path.join(bundleRoot, 'dist', 'entry', 'cortex-cli.js'), cortex);
  return {
    root: bundleRoot,
    cortex,
    supervisor: path.join(bundleRoot, 'native', 'cortex-supervisor', 'dist', 'cortex-supervisor'),
  };
}

function seedHostHome(): string {
  const home = path.join(root, 'host-cortex');
  write(path.join(home, 'config', 'profiles.json'), JSON.stringify({
    defaultProfile: 'benchmark',
    profiles: { benchmark: { model: 'host-model', backend: 'pi', provider: 'host-provider' } },
  }));
  return home;
}

it('executes the packed package bin from the public projection with no ambient fallback', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(installed.root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.cortex, 'dist/entry/cortex-cli.js');
  assert.equal(fs.readFileSync(installed.cortex, 'utf8').startsWith('#!/usr/bin/env node\n'), true);
  assert.notEqual(fs.statSync(installed.cortex).mode & 0o111, 0);
  const backend = fakeBackend();
  const runConfig = armResolution(backend.cli, installed.root);
  const workspace = path.join(root, 'workspace');
  const trajectory = path.join(root, 'agent', 'trajectory');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(trajectory, { recursive: true });
  const result = spawnSync(installed.cortex, ['agent-run',
    '--prompt-file', write(path.join(root, 'agent', 'instruction.md'), 'Complete the task.'),
    '--agent-slot', 'parent', '--profile', 'benchmark', '--cwd', workspace,
    '--output-format', 'jsonl', '--events-file', path.join(trajectory, 'events.jsonl'),
    '--trajectory-root', trajectory, '--root-run-id', 'trial-public-cli.cortex-direct',
    '--run-config', runConfig, '--supervisor-binary', installed.supervisor,
  ], {
    cwd: workspace, encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env,
      CORTEX_HOME: seedHostHome(),
      CORTEX_PROJECTS_DIR: path.join(root, 'host-projects'),
      SLACK_BOT_TOKEN: 'forbidden-slack-token',
      FEISHU_APP_SECRET: 'forbidden-feishu-token',
      CORTEX_REMOTE_TOKEN: 'forbidden-remote-token',
      ANTHROPIC_API_KEY: 'forbidden-provider-key',
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const terminal = result.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.equal(terminal.type, 'terminal');
  assert.equal(terminal.state, 'completed');
  const journal = fs.readFileSync(path.join(trajectory, 'events.jsonl'), 'utf8')
    .trimEnd().split('\n').map(line => JSON.parse(line));
  const admissions = journal.filter(record => record.type === 'state_admission');
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].seq, 1);
  assert.equal(admissions[0].root_run_id, 'trial-public-cli.cortex-direct');
  assert.equal(
    admissions[0].model_execution_identity_hash,
    terminal.manifest.model_execution_identity_hash,
  );
  assert.deepEqual(admissions[0].evidence, {
    schema_version: 'cortex-standalone-state-admission/1',
    empty_before_projection: true,
    roots: {
      project: 'projects', task: 'cortex-home/state/tasks.json',
      thread: 'cortex-home/state/threads.json', session: 'cortex-home/state/sessions.json',
      execution: 'cortex-home/state/executions.json', cache: 'xdg-cache', temp: 'tmp',
      backend: 'claude-config',
    },
  });
  assert.equal(
    terminal.manifest.event_count,
    journal.filter(record => record.type === 'event').length,
  );
  const state = path.join(root, 'agent', 'trial-home', 'cortex-home', 'state');
  assert.deepEqual(fs.readdirSync(state).sort(), [
    'executions.json', 'sessions.json', 'tasks.json', 'threads.json',
  ]);
  const observed = JSON.parse(fs.readFileSync(backend.observation, 'utf8'));
  assert.equal(observed.env.CORTEX_HOME,
    path.join(root, 'agent', 'trial-home', 'cortex-home'));
  assert.equal(observed.env.CORTEX_PROJECTS_DIR,
    path.join(root, 'agent', 'trial-home', 'projects'));
  assert.equal(observed.env.SLACK_BOT_TOKEN, undefined);
  assert.equal(observed.env.FEISHU_APP_SECRET, undefined);
  assert.equal(observed.env.CORTEX_REMOTE_TOKEN, undefined);
  assert.equal(observed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(observed.env.ANTHROPIC_AUTH_TOKEN, 'offline-token');
  assert.equal(observed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  assert.equal(fs.existsSync(path.join(root, 'host-cortex', 'data', 'threads.json')), false);
}, 180_000);

it('withholds packed handoff when state admission disappears after terminal publication', () => {
  const base = path.join(root, 'missing-admission-handoff');
  const backend = fakeBackend(base);
  const trialId = 'trial-missing-admission';
  const runConfig = armResolution(backend.cli, installed.root, base, trialId);
  const workspace = path.join(base, 'workspace');
  const trajectory = path.join(base, 'agent', 'trajectory');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(trajectory, { recursive: true });
  const preload = tamperStateAdmissionAfterTerminal(base);
  const result = spawnSync(installed.cortex, ['agent-run',
    '--prompt-file', write(path.join(base, 'agent', 'instruction.md'), 'Complete the task.'),
    '--agent-slot', 'parent', '--profile', 'benchmark', '--cwd', workspace,
    '--output-format', 'jsonl', '--events-file', path.join(trajectory, 'events.jsonl'),
    '--trajectory-root', trajectory, '--root-run-id', `${trialId}.cortex-direct`,
    '--run-config', runConfig, '--supervisor-binary', installed.supervisor,
  ], { cwd: workspace, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}` } });
  assert.equal(fs.existsSync(path.join(base, 'admission-tampered')), true);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const terminal = result.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.equal(terminal.state, 'failed'); assert.equal(terminal.manifest, null);
  assert.match(result.stderr, /malformed_fragment/);
  assert.equal(fs.existsSync(path.join(trajectory, 'trajectory.json')), false);
  assert.equal(fs.existsSync(path.join(trajectory, 'composite-manifest.json')), false);
}, 180_000);

it('runs packed PI with only the trial dummy auth file and scoped proxy catalog', () => {
  const base = path.join(root, 'pi-public');
  const observation = path.join(base, 'backend-observation.json');
  const fixture = path.join(serverRoot, 'tests/domain/agent-run/pi-rpc-cli.mjs');
  const cli = write(
    path.join(base, 'bundle', 'pi'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} `
      + `--observation ${JSON.stringify(observation)} "$@"\n`,
    0o755,
  );
  const trialId = 'trial-public-pi';
  const runConfig = armResolution(cli, installed.root, base, trialId, 'pi');
  const workspace = path.join(base, 'workspace');
  const trajectory = path.join(base, 'agent', 'trajectory');
  const hostHome = path.join(base, 'host-home');
  write(path.join(hostHome, '.pi', 'agent', 'auth.json'), JSON.stringify({
    anthropic: { type: 'api', key: 'forbidden-host-key' },
  }));
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(trajectory, { recursive: true });
  const result = spawnSync(installed.cortex, ['agent-run',
    '--prompt-file', write(path.join(base, 'agent', 'instruction.md'), 'Complete the task.'),
    '--agent-slot', 'parent', '--profile', 'benchmark', '--cwd', workspace,
    '--output-format', 'jsonl', '--events-file', path.join(trajectory, 'events.jsonl'),
    '--trajectory-root', trajectory, '--root-run-id', `${trialId}.cortex-pi-direct`,
    '--run-config', runConfig, '--supervisor-binary', installed.supervisor,
  ], {
    cwd: workspace, encoding: 'utf8', timeout: 60_000,
    env: {
      ...process.env, HOME: hostHome,
      ANTHROPIC_API_KEY: 'forbidden-provider-key',
      ANTHROPIC_AUTH_TOKEN: 'forbidden-provider-token',
      CORTEX_DAEMON_URL: 'http://127.0.0.1:9',
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const terminal = result.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.equal(terminal.state, 'completed');
  const observed = JSON.parse(fs.readFileSync(observation, 'utf8'));
  const agentDir = path.join(base, 'agent', 'trial-home', 'pi-agent');
  assert.equal(observed.env.PI_CODING_AGENT_DIR, agentDir);
  assert.equal(observed.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(observed.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(observed.env.CORTEX_DAEMON_URL, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8')), {
    anthropic: { type: 'api', key: 'offline-token' },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')), {
    providers: { anthropic: { baseUrl: 'http://127.0.0.1:1' } },
  });
}, 180_000);

function procTokenPids(token: string): number[] {
  return fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap((entry) => {
    try {
      const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      return command.includes(token) ? [Number(entry)] : [];
    } catch { return []; }
  });
}

async function waitForPath(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await delay(10);
  }
}

async function waitForNoToken(token: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (procTokenPids(token).length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`surviving hostile descendants: ${procTokenPids(token).join(',')}`);
    }
    await delay(10);
  }
}

function cleanupToken(token: string): void {
  for (const pid of procTokenPids(token)) {
    try { process.kill(pid, 'SIGKILL'); }
    catch { /* process already exited */ }
  }
}

it('reaps the public path hostile tree when agent-run transport disappears', async () => {
  const base = path.join(root, 'transport-loss');
  const token = `public-hostile-${randomUUID()}`;
  const hostileWorkspace = path.join(base, 'hostile-workspace');
  fs.mkdirSync(hostileWorkspace, { recursive: true });
  const fixtureScript = path.join(serverRoot, 'tests/native/fixtures/fake-agent.sh');
  const cli = write(
    path.join(base, 'bundle', 'claude'),
    `#!/bin/sh\nexec /bin/sh ${JSON.stringify(fixtureScript)} ${JSON.stringify(hostileHelper)} `
      + `${JSON.stringify(token)} ${JSON.stringify(hostileWorkspace)} stay\n`,
    0o755,
  );
  const trialId = 'trial-public-transport-loss';
  const runConfig = armResolution(cli, installed.root, base, trialId);
  const workspace = path.join(base, 'workspace');
  const trajectory = path.join(base, 'agent', 'trajectory');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(trajectory, { recursive: true });
  const child = spawn(installed.cortex, ['agent-run',
    '--prompt-file', write(path.join(base, 'agent', 'instruction.md'), 'Complete the task.'),
    '--agent-slot', 'parent', '--profile', 'benchmark', '--cwd', workspace,
    '--output-format', 'jsonl', '--events-file', path.join(trajectory, 'events.jsonl'),
    '--trajectory-root', trajectory, '--root-run-id', `${trialId}.cortex-direct`,
    '--run-config', runConfig, '--supervisor-binary', installed.supervisor,
  ], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout?.on('data', chunk => { diagnostics += chunk.toString(); });
  child.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });

  try {
    await Promise.race([
      waitForPath(path.join(hostileWorkspace, 'ready'), 30_000),
      new Promise<never>((_, reject) => child.once('close', (code, signal) => {
        reject(new Error(`agent-run exited before hostile readiness: ${code}/${signal}\n${diagnostics}`));
      })),
    ]);
    assert.equal(child.kill('SIGKILL'), true);
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    await waitForNoToken(token);
    assert.equal(fs.existsSync(path.join(trajectory, 'composite-manifest.json')), false);
    assert.equal(fs.readdirSync(trajectory).some(name => name.endsWith('.terminal.json')), false);
  } finally {
    cleanupToken(token);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 180_000);
