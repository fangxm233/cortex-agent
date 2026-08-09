// input:  built package bin, public arm projection, fake backend and supervisor
// output: installed-form public CLI execution with fresh trial-local state
// pos:    Exact cortex agent-run standalone execution regression
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';

const serverRoot = path.resolve('.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-public-cli-'));

function run(command: string, args: string[], timeout = 120_000) {
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
}, 180_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

function fakeBackend(): { cli: string; observation: string } {
  const observation = path.join(root, 'backend-observation.json');
  const script = write(path.join(root, 'bundle', 'fake-claude.mjs'), `
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
    path.join(root, 'bundle', 'claude'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    0o755,
  );
  return { cli, observation };
}

function armResolution(cli: string, bundleRoot: string): string {
  const defaults = path.join(bundleRoot, 'defaults');
  const document = {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2', kind: 'cortex', name: 'cortex-direct',
      backend: 'claude', provider: 'anthropic', model: 'claude-sonnet',
      credential_capability: 'claude-api-key',
      orchestration: { mode: 'direct', ask_manager: false },
      limits: {
        max_thread_starts: 0, max_parent_questions: 0, max_task_depth: 0, max_tasks: 0,
        max_provider_requests: 4, max_resident_agent_processes: 1,
        max_cost_usd: '1.00', deadline_seconds: 30,
      },
    },
    arm_path: 'arm://cortex-direct', trial_id: 'trial-public-cli',
    root_run_id: 'trial-public-cli.cortex-direct',
    task: { task_id: 'task-public-cli', image_ref: 'image@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}` },
    profile_name: 'benchmark', paid_run: false,
    credential_capabilities: [{
      id: 'claude-api-key', state: 'offline-contract-passed',
      key: { runner_or_backend: 'claude', provider: 'anthropic',
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
      tools: ['Read', 'Write'], plugin_dirs: [], mcp_composition: 'none',
      mcp_config_paths: [], disable_hooks: true,
    } },
    thread_templates: {}, thread_agents: {},
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
  return write(path.join(root, 'agent', 'arm-resolution.json'), JSON.stringify(document));
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
  fs.symlinkSync(path.resolve(serverRoot, '..', 'node_modules'),
    path.join(bundleRoot, 'node_modules'));
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
  const installed = installPackedBundle();
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
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const terminal = result.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.equal(terminal.type, 'terminal');
  assert.equal(terminal.state, 'completed');
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
  assert.equal(fs.existsSync(path.join(root, 'host-cortex', 'data', 'threads.json')), false);
}, 180_000);
