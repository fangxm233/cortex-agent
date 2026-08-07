// input:  hook CLI, registry sync, temporary hook/template files
// output: CLI metadata, mutation, execution, and package tests
// pos:    Verifies the declarative hook registry CLI contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

import { runHookCli, type HookCliOptions } from '../../src/entry/hook-cli.js';
import { syncManagedHookEntries } from '../../src/store/hook-sync.js';

interface Fixture {
  root: string;
  registryDir: string;
  templateDir: string;
  hooksDir: string;
  options: HookCliOptions;
}

function makeFixture(t: { onTestFinished(callback: () => void): void }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cli-'));
  const registryDir = path.join(root, 'config', 'hooks');
  const templateDir = path.join(root, 'config', 'thread-templates', 'templates');
  const hooksDir = path.join(root, 'hooks');
  for (const directory of [registryDir, templateDir, hooksDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, registryDir, templateDir, hooksDir, options: { registryDir, templateDir, hooksDir } };
}

function writeJson(directory: string, filename: string, value: unknown): void {
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function registryEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    event: 'agent:pre-tool',
    matcher: 'Edit',
    run: { command: 'true', timeout: 1 },
    enabled: true,
    ...extra,
  };
}

function seedMountedHooks(fixture: Fixture): void {
  writeJson(fixture.registryDir, '01-managed.json', registryEntry('managed', {
    blocking: { mode: 'webhook', ttlMin: 17 }, version: '2026.7.30',
  }));
  writeJson(fixture.registryDir, '02-user.json', registryEntry('user'));
  writeJson(fixture.registryDir, '03-disabled.json', registryEntry('disabled', { enabled: false }));
  writeJson(fixture.templateDir, 'review.json', {
    name: 'review',
    hooks: {
      onEnd: { command: 'node review.mjs', args: ['reviewer'], timeout: 1_500 },
    },
  });
}

function parseOutput(result: { stdout: string }): any {
  return JSON.parse(result.stdout);
}

function withoutTimestamp(value: Record<string, unknown>): Record<string, unknown> {
  const { timestamp: _timestamp, ...rest } = value;
  return rest;
}

function writePayloadHook(fixture: Fixture, filename: string, exitCode = 0): void {
  fs.writeFileSync(path.join(fixture.hooksDir, filename), [
    "const chunks = [];",
    "process.stdin.on('data', chunk => chunks.push(chunk));",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(Buffer.concat(chunks));",
    "  process.stderr.write('hook warning');",
    `  process.exit(${exitCode});`,
    "});",
  ].join('\n'));
}

test('root and subcommand help use copyable cortex-hook examples', async (t) => {
  const fixture = makeFixture(t);
  const root = await runHookCli(['--help'], fixture.options);
  assert.equal(root.exitCode, 0);
  assert.match(root.stdout, /Usage: cortex-hook <command> \[options\]/);
  assert.match(root.stdout, /cortex-hook test --id tasks-yaml-guard --payload payload\.json/);
  for (const command of ['list', 'show', 'enable', 'disable', 'test', 'ask']) {
    const result = await runHookCli([command, '-h'], fixture.options);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(`Usage: cortex-hook ${command}`));
    assert.match(result.stdout, /Examples:/);
  }
});

test('list reports every registry and template hook with source and state', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);

  const result = await runHookCli(['list'], fixture.options);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(parseOutput(result), {
    ok: true,
    hooks: [
      { id: 'managed', event: 'agent:pre-tool', enabled: true, source: 'managed' },
      { id: 'user', event: 'agent:pre-tool', enabled: true, source: 'user' },
      { id: 'disabled', event: 'agent:pre-tool', enabled: false, source: 'user' },
      { id: 'template:review:end', event: 'cortex:thread.end', enabled: true, source: 'template-scoped' },
    ],
  });
});

test('show returns the full registry or normalized template declaration', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);

  const managed = parseOutput(await runHookCli(['show', '--id', 'managed'], fixture.options));
  assert.equal(managed.hook.source, 'managed');
  assert.equal(managed.hook.version, '2026.7.30');
  assert.deepEqual(managed.hook.run, { command: 'true', timeout: 1 });
  assert.deepEqual(managed.hook.blocking, { mode: 'webhook', ttlMin: 17 });

  const scoped = parseOutput(await runHookCli(
    ['show', '--id', 'template:review:end'], fixture.options,
  ));
  assert.deepEqual(scoped.hook, {
    id: 'template:review:end', event: 'cortex:thread.end',
    run: { command: 'node review.mjs', args: ['reviewer'], timeout: 1_500 },
    enabled: true, source: 'template-scoped', template: 'review', phase: 'end',
  });
});

test('disable and enable are atomic idempotent transitions', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);
  const file = path.join(fixture.registryDir, '02-user.json');

  const disabled = parseOutput(await runHookCli(['disable', '--id', 'user'], fixture.options));
  assert.match(disabled.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(withoutTimestamp(disabled), {
    ok: true, id: 'user', enabled: false, changed: true, dry_run: false, source: 'user',
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false);
  const bytes = fs.readFileSync(file, 'utf8');

  const repeated = parseOutput(await runHookCli(['disable', '--id', 'user'], fixture.options));
  assert.equal(repeated.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(parseOutput(await runHookCli(['enable', '--id', 'user'], fixture.options)).changed, true);
  assert.equal(fs.readdirSync(fixture.registryDir).some((name) => name.includes('.tmp.')), false);
});

test('dry-run validates and previews without writing', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);
  const file = path.join(fixture.registryDir, '02-user.json');
  const before = fs.readFileSync(file, 'utf8');

  const output = parseOutput(await runHookCli(
    ['disable', '--id', 'user', '--dry-run'], fixture.options,
  ));

  assert.deepEqual(withoutTimestamp(output), {
    ok: true, id: 'user', enabled: false, changed: true, dry_run: true,
    source: 'user', would_set: { enabled: false },
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('managed disable warns that a newer sync restores shipped state', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);
  const output = parseOutput(await runHookCli(['disable', '--id', 'managed'], fixture.options));
  assert.match(output.warnings[0], /managed.*sync.*restore/i);

  const source = path.join(fixture.root, 'defaults');
  fs.mkdirSync(source);
  writeJson(source, '01-managed.json', registryEntry('managed', { version: '2026.7.31' }));
  assert.deepEqual(await syncManagedHookEntries({ srcDir: source, dstDir: fixture.registryDir }), [
    '01-managed.json',
  ]);
  const deployed = JSON.parse(fs.readFileSync(path.join(fixture.registryDir, '01-managed.json'), 'utf8'));
  assert.equal(deployed.enabled, true);
});

test('template hooks are read-only and errors list registry ids', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);

  const result = await runHookCli(['disable', '--id', 'template:review:end'], fixture.options);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /template-scoped hooks are read-only/i);
  assert.match(result.stderr, /Valid values: managed, user, disabled/);
});

test('invalid commands, flags, and ids fail fast with valid alternatives', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);

  const command = await runHookCli(['lsit'], fixture.options);
  assert.equal(command.exitCode, 1);
  assert.match(command.stderr, /Valid values: list, show, enable, disable, test/);
  const flag = await runHookCli(['list', '--id', 'user'], fixture.options);
  assert.equal(flag.exitCode, 1);
  assert.match(flag.stderr, /Valid values: --help, -h/);
  const id = await runHookCli(['show', '--id', 'missing'], fixture.options);
  assert.equal(id.exitCode, 1);
  assert.match(id.stderr, /managed, user, disabled, template:review:end/);
});

test('duplicate registry and template ids fail instead of selecting silently', async (t) => {
  const fixture = makeFixture(t);
  seedMountedHooks(fixture);
  writeJson(fixture.registryDir, '04-collision.json', registryEntry('template:review:end'));

  const result = await runHookCli(['show', '--id', 'template:review:end'], fixture.options);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Ambiguous hook id: 'template:review:end'/);
  assert.match(result.stderr, /Hint: Rename one declaration/);
});

test('test executes a registry script with a file payload through the shared runner', async (t) => {
  const fixture = makeFixture(t);
  writePayloadHook(fixture, 'payload.mjs');
  writeJson(fixture.registryDir, 'payload.json', registryEntry('payload', {
    run: { script: 'payload.mjs', timeout: 1 }, enabled: false,
  }));
  const payloadPath = path.join(fixture.root, 'payload.json');
  fs.writeFileSync(payloadPath, '{"value":"file payload"}\n');

  const result = await runHookCli(
    ['test', '--id', 'payload', '--payload', payloadPath], fixture.options,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(parseOutput(result), {
    ok: true, id: 'payload', exit_code: 0,
    stdout: '{"value":"file payload"}', stderr: 'hook warning',
  });
});

test('test executes a registry command with payload and structured output', async (t) => {
  const fixture = makeFixture(t);
  const script = path.join(fixture.root, 'command-hook.mjs');
  fs.writeFileSync(script, [
    "const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk));",
    "process.stdin.on('end', () => {",
    "  process.stdout.write('command|' + Buffer.concat(chunks));",
    "  process.stderr.write('command warning');",
    "});",
  ].join('\n'));
  writeJson(fixture.registryDir, 'command.json', registryEntry('command', {
    run: { command: `node ${JSON.stringify(script)}`, timeout: 1 },
  }));
  const payloadPath = path.join(fixture.root, 'command-payload.txt');
  fs.writeFileSync(payloadPath, 'registry command payload');

  const result = await runHookCli(
    ['test', '--id', 'command', '--payload', payloadPath], fixture.options,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(parseOutput(result), {
    ok: true, id: 'command', exit_code: 0,
    stdout: 'command|registry command payload', stderr: 'command warning',
  });
});

test('test reports unreadable payloads with valid alternatives', async (t) => {
  const fixture = makeFixture(t);
  writeJson(fixture.registryDir, 'payload.json', registryEntry('payload'));
  const missing = path.join(fixture.root, 'missing.json');

  const result = await runHookCli(
    ['test', '--id', 'payload', '--payload', missing], fixture.options,
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, new RegExp(`Cannot read --payload file '${missing}'`));
  assert.match(result.stderr, /Valid values: existing file path, -/);
});

test('test preserves output and mirrors a non-zero hook exit', async (t) => {
  const fixture = makeFixture(t);
  writePayloadHook(fixture, 'failure.mjs', 7);
  writeJson(fixture.registryDir, 'failure.json', registryEntry('failure', {
    run: { script: 'failure.mjs', timeout: 1 },
  }));
  const payloadPath = path.join(fixture.root, 'payload.txt');
  fs.writeFileSync(payloadPath, 'partial output');

  const result = await runHookCli(
    ['test', '--id', 'failure', '--payload', payloadPath], fixture.options,
  );

  assert.equal(result.exitCode, 7);
  assert.deepEqual(parseOutput(result), {
    ok: false, id: 'failure', exit_code: 7,
    stdout: 'partial output', stderr: 'hook warning', error: 'exited with code 7',
  });
});

test('test executes a template command with positional args', async (t) => {
  const fixture = makeFixture(t);
  const script = path.join(fixture.root, 'template-hook.mjs');
  fs.writeFileSync(script, [
    "const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk));",
    "process.stdin.on('end', () => process.stdout.write(process.argv[2] + '|' + Buffer.concat(chunks)));",
  ].join('\n'));
  writeJson(fixture.templateDir, 'execute.json', {
    hooks: { onStart: { command: `node ${JSON.stringify(script)}`, args: ['scoped arg'], timeout: 1_000 } },
  });
  const payloadPath = path.join(fixture.root, 'template-payload.txt');
  fs.writeFileSync(payloadPath, 'template payload');

  const result = await runHookCli(
    ['test', '--id', 'template:execute:start', '--payload', payloadPath], fixture.options,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(parseOutput(result).stdout, 'scoped arg|template payload');
});

test('--payload - reads process stdin in the executable CLI', (t) => {
  const fixture = makeFixture(t);
  writePayloadHook(fixture, 'stdin.mjs');
  writeJson(fixture.registryDir, 'stdin.json', registryEntry('stdin', {
    run: { script: 'stdin.mjs', timeout: 1 },
  }));
  const cli = path.resolve('src/entry/hook-cli.ts');
  const payload = 'stdin payload\nwith second line\n';

  const child = spawnSync(process.execPath, [
    '--import', 'tsx', cli, 'test', '--id', 'stdin', '--payload', '-',
  ], {
    cwd: path.resolve('.'), env: { ...process.env, CORTEX_HOME: fixture.root },
    input: payload, encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: true, id: 'stdin', exit_code: 0,
    stdout: payload.trim(), stderr: 'hook warning',
  });
});

// ── cortex-hook ask — hook-facing ask-user API ─────────────────────────────────

const ASK_ENV_KEYS = ['CORTEX_HOOK_CHANNEL', 'SLACK_CHANNEL', 'CORTEX_HOOK_SESSION_ID', 'CORTEX_THREAD_ID'];

function clearAskEnv(t: { onTestFinished(callback: () => void): void }): void {
  const saved = Object.fromEntries(ASK_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ASK_ENV_KEYS) delete process.env[k];
  t.onTestFinished(() => {
    for (const k of ASK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function makeAskPost(response: { status?: number; body: any }) {
  const calls: { url: string; body: any }[] = [];
  const askPost = async (url: string, body: any) => {
    calls.push({ url, body });
    return { status: response.status ?? 200, body: response.body };
  };
  return { askPost, calls };
}

test('ask posts a single flag-built question and prints structured answers', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const { askPost, calls } = makeAskPost({ body: { answers: { 'Clean up?': 'Yes' } } });

  const result = await runHookCli([
    'ask', '--question', 'Clean up?', '--header', 'Disk',
    '--options', 'Yes|No', '--level', 'warn', '--channel', 'C_CLI',
  ], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(parseOutput(result), { ok: true, answers: { 'Clean up?': 'Yes' } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/hook\/ask-user-question$/);
  assert.equal(calls[0].body.channel, 'C_CLI');
  assert.equal(calls[0].body.level, 'warning');
  assert.deepEqual(calls[0].body.questions, [{
    question: 'Clean up?', header: 'Disk', multiSelect: false,
    options: [{ label: 'Yes' }, { label: 'No' }],
  }]);
});

test('ask resolves the channel from the hook env when --channel is absent', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  process.env.CORTEX_HOOK_CHANNEL = 'C_ENV_HOOK';
  const { askPost, calls } = makeAskPost({ body: { answers: {} } });

  const result = await runHookCli(['ask', '--question', 'Go?'], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls[0].body.channel, 'C_ENV_HOOK');
});

test('ask fails fast without any channel or session source', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const { askPost, calls } = makeAskPost({ body: { answers: {} } });

  const result = await runHookCli(['ask', '--question', 'Go?'], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--channel|--session-id/);
  assert.equal(calls.length, 0);
});

test('ask rejects an invalid --level with valid values', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const { askPost, calls } = makeAskPost({ body: { answers: {} } });

  const result = await runHookCli([
    'ask', '--question', 'Go?', '--channel', 'C', '--level', 'fatal',
  ], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Invalid --level: 'fatal'/);
  assert.match(result.stderr, /info, warn, warning, error/);
  assert.equal(calls.length, 0);
});

test('ask requires --question or --payload', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const result = await runHookCli(['ask', '--channel', 'C'], fixture.options);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--question|--payload/);
});

test('ask reads a multi-question payload file and forwards sessionId', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const questions = [
    { question: 'A?', header: 'A', options: [], multiSelect: false },
    { question: 'B?', header: 'B', options: [{ label: 'x' }], multiSelect: true },
  ];
  const payloadPath = path.join(fixture.root, 'questions.json');
  fs.writeFileSync(payloadPath, JSON.stringify(questions));
  const { askPost, calls } = makeAskPost({ body: { answers: { 'A?': 'a', 'B?': 'x' } } });

  const result = await runHookCli([
    'ask', '--payload', payloadPath, '--session-id', 'sid-cli-1',
  ], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls[0].body.sessionId, 'sid-cli-1');
  assert.equal(calls[0].body.channel, undefined);
  assert.deepEqual(calls[0].body.questions, questions);
});

test('ask maps a bridge timeout to exit code 2', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const { askPost } = makeAskPost({ body: { error: 'timeout', answers: {} } });

  const result = await runHookCli(['ask', '--question', 'Go?', '--channel', 'C'], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 2);
  const output = parseOutput(result);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'timeout');
});

test('ask --dry-run flows the smoke-test flag to the webhook body', async (t) => {
  const fixture = makeFixture(t);
  clearAskEnv(t);
  const { askPost, calls } = makeAskPost({ body: { dryRun: true, answers: {} } });

  const result = await runHookCli([
    'ask', '--question', 'Go?', '--channel', 'C', '--dry-run',
  ], { ...fixture.options, askPost });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(calls[0].body.dryRun, true);
  assert.equal(parseOutput(result).dry_run, true);
});

test('package bin, lockfile, and build shebang wiring include cortex-hook', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));
  const copyAssets = fs.readFileSync(path.resolve('scripts/copy-assets.js'), 'utf8');

  assert.equal(packageJson.bin['cortex-hook'], 'dist/entry/hook-cli.js');
  assert.equal(packageLock.packages[''].bin['cortex-hook'], 'dist/entry/hook-cli.js');
  assert.match(copyAssets, /dist\/entry\/hook-cli\.js/);
});
