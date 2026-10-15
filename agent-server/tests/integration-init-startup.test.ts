import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── Paths ────────────────────────────────────────────────────────

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_TS = path.join(TEST_ROOT, 'src', 'entry', 'cli.ts');
const APP_TS = path.join(TEST_ROOT, 'src', 'entry', 'app.ts');

const NODE = process.execPath;
const TSX_FLAGS = ['--import', 'tsx'];

/** Pick a random high port to avoid conflicts with running instances. */
function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 25000);
}

// ─── Child-process lifecycle (leak guard) ─────────────────────────
// Integration tests fork real cli.ts / app.ts processes. If a readiness assertion
// throws, or the node:test per-test timeout fires (which abandons in-flight work),
// the spawned child is NOT auto-killed and gets reparented to init — leaking long-
// running server processes (the historical /tmp/cortex-int-* orphans). We track every
// spawned child and force-kill the whole process group on test teardown AND on process
// exit (the latter is the backstop for --test-force-exit / timeouts; it must be sync).

const liveChildren = new Set<ChildProcess>();

/** Spawn with a dedicated process group + tracking so we can reap the whole tree. */
function trackedSpawn(executable: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  const child = spawn(executable, args, { ...options, detached: true });
  liveChildren.add(child);
  child.on('close', () => liveChildren.delete(child));
  return child;
}

/** Force-kill a child and any descendants via its process group. Best-effort, sync-safe. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

afterAll(() => {
  for (const c of liveChildren) killTree(c);
  liveChildren.clear();
});
// Backstop: runs even under --test-force-exit / test timeout. Must be synchronous.
function reapAll(): void {
  for (const c of liveChildren) { if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } }
}
process.on('exit', reapAll);
// Catchable signals (e.g. a `timeout` wrapper or Ctrl-C) don't trigger 'exit', so reap
// explicitly then re-exit. SIGKILL is uncatchable — detached children would still orphan
// there, which is why the standard run path relies on normal exit / --test-force-exit.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => { reapAll(); process.exit(1); });
}

// ─── Helpers ──────────────────────────────────────────────────────

function spawnWait(executable: string, args: string[], opts: {
  stdin?: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = trackedSpawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out after ${opts.timeoutMs ?? 'default'}ms`));
    }, opts.timeoutMs ?? 60_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Init a cortex data directory via `node --import tsx cli.ts init --home <dir>`.
 *
 * `--gateway-config-dir` is also pinned to a tempDir sub-path so the test never touches
 * the production `~/.aistatus/gateway.yaml` (cortex init writes & backs up that file
 * by default — see writeMergedGatewayYaml in src/core/gateway-generator.ts).
 */
async function cortexInit(homeDir: string, stdinAnswers: string): Promise<void> {
  const gatewayDir = path.join(homeDir, 'aistatus');
  const initResult = await spawnWait(NODE, [
    ...TSX_FLAGS,
    CLI_TS,
    'init',
    '--home', homeDir,
    '--gateway-config-dir', gatewayDir,
  ], {
    stdin: stdinAnswers,
    timeoutMs: 120_000,
  });

  // Non-interactive init should succeed
  assert.equal(initResult.exitCode, 0,
    `cortex init failed with exitCode=${initResult.exitCode}\nstderr: ${initResult.stderr}`);
}

function installLifecycleHook(
  homeDir: string,
  filePrefix: string,
  event: string,
  scriptName: string,
): void {
  const entry = {
    id: filePrefix,
    event,
    run: { script: scriptName, timeout: 2 },
  };
  writeFileSync(
    path.join(homeDir, 'config', 'hooks', `${filePrefix}.json`),
    JSON.stringify(entry),
  );
}

async function waitForPayload(filePath: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) return JSON.parse(lines.at(-1)!);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for hook payload: ${filePath}`);
}

// ─── Tests ────────────────────────────────────────────────────────

/**
 * Snapshot mtime of `~/.aistatus/gateway.yaml` (if it exists) before each test, and
 * confirm it is unchanged after — regression for "cortex init test accidentally
 * overwrites production gateway.yaml" when --gateway-config-dir is not passed.
 */
function snapshotProdGatewayMtime(): number | null {
  const prodGateway = path.join(os.homedir(), '.aistatus', 'gateway.yaml');
  if (!existsSync(prodGateway)) return null;
  return statSync(prodGateway).mtimeMs;
}

function assertProdGatewayUntouched(snapshot: number | null): void {
  const prodGateway = path.join(os.homedir(), '.aistatus', 'gateway.yaml');
  if (snapshot === null) {
    assert.ok(!existsSync(prodGateway),
      `cortex init must not create ~/.aistatus/gateway.yaml when --gateway-config-dir is passed`);
    return;
  }
  assert.ok(existsSync(prodGateway), '~/.aistatus/gateway.yaml went missing during test');
  const after = statSync(prodGateway).mtimeMs;
  assert.equal(after, snapshot,
    `cortex init must not modify production ~/.aistatus/gateway.yaml (mtime drifted from ${snapshot} to ${after})`);
}

test('Test 1: cortex init creates valid directory structure (non-interactive)', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-int-'));
  const prodGatewaySnap = snapshotProdGatewayMtime();
  try {
    // Run init with piped stdin: backend=claude, platform=none, gateway=n, installService=n
    await cortexInit(tempDir, 'claude\nnone\nn\nn\nn\nn\n');
    assertProdGatewayUntouched(prodGatewaySnap);

    // Assert core directory structure
    const dirs = [
      path.join(tempDir, 'config'),
      path.join(tempDir, 'data'),
      path.join(tempDir, 'context'),
      path.join(tempDir, 'context', 'projects'),
      path.join(tempDir, 'tmp'),
      path.join(tempDir, '.claude'),
    ];
    for (const dir of dirs) {
      assert.ok(existsSync(dir), `Expected directory to exist: ${dir}`);
    }

    // Assert config files
    const files = [
      path.join(tempDir, 'config', '.env'),
      path.join(tempDir, 'config', 'mcp-config.json'),
      path.join(tempDir, 'config', 'mcp-config-core.json'),
      path.join(tempDir, 'data', 'agent-state.json'),
      path.join(tempDir, 'config', 'environments', 'main.json'),
      path.join(tempDir, 'config', 'environments', 'creative.json'),
    ];
    for (const f of files) {
      assert.ok(existsSync(f), `Expected file to exist: ${f}`);
    }

    for (const retired of ['mcp-config-tasks.json', 'mcp-config-manager-qa.json', 'mcp-config-thread.json']) {
      assert.equal(existsSync(path.join(tempDir, 'config', retired)), false, retired);
    }

    // Assert machines.json exists and contains local machine entry
    const machinesJsonPath = path.join(tempDir, 'config', 'machines.json');
    assert.ok(existsSync(machinesJsonPath),
      'Expected machines.json to be created by cortex init');
    const machines = JSON.parse(readFileSync(machinesJsonPath, 'utf-8'));
    const machineKeys = Object.keys(machines);
    assert.equal(machineKeys.length, 1, 'machines.json should contain exactly one machine entry');
    const localEntry = machines[machineKeys[0]];
    assert.equal(typeof localEntry.cortexPath, 'string', 'local entry should have cortexPath');
    assert.equal(localEntry.cortexPath, tempDir, 'local entry cortexPath should equal DATA_DIR');
    assert.equal(typeof localEntry.gpuCount, 'number', 'local entry should have gpuCount');
    assert.ok(localEntry.gpuCount >= 0, 'gpuCount should be non-negative');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test 2: Server starts and shuts down cleanly in initialized environment', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-int-'));
  let child: ChildProcess | undefined;
  try {
    // Init first, then remove one generated layer to prove startup recreates it.
    await cortexInit(tempDir, 'claude\nnone\nn\nn\nn\nn\n');
    const coreConfigPath = path.join(tempDir, 'config', 'mcp-config-core.json');
    rmSync(coreConfigPath);
    assert.equal(existsSync(coreConfigPath), false);
    const configHooksDir = path.join(tempDir, 'config', 'hooks');
    const hookScriptsDir = path.join(tempDir, 'hooks');
    mkdirSync(configHooksDir, { recursive: true });
    mkdirSync(hookScriptsDir, { recursive: true });
    writeFileSync(path.join(configHooksDir, 'zz-invalid.json'), '{bad json');

    const startPayloadPath = path.join(tempDir, 'start-event.jsonl');
    const shutdownPayloadPath = path.join(tempDir, 'shutdown-event.jsonl');
    const failingCaptureScript = (payloadPath: string) => [
      "import { appendFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      `process.stdin.on('end', () => { appendFileSync(${JSON.stringify(payloadPath)}, input + '\\n'); process.exitCode = 7; });`,
    ].join('\n');
    writeFileSync(path.join(hookScriptsDir, 'capture-fail-start.mjs'), failingCaptureScript(startPayloadPath));
    writeFileSync(path.join(hookScriptsDir, 'capture-fail-shutdown.mjs'), failingCaptureScript(shutdownPayloadPath));
    installLifecycleHook(tempDir, 'aa-start-capture-fail', 'cortex:server.start', 'capture-fail-start.mjs');
    installLifecycleHook(tempDir, 'ab-shutdown-capture-fail', 'cortex:server.shutdown', 'capture-fail-shutdown.mjs');

    // Fork app.ts directly with test platform
    const webhookPort = String(randomPort());
    const clientPort = String(randomPort());
    // The server resolves ~/.aistatus via os.homedir(): its gateway child reads gateway.yaml and
    // records usage under ~/.aistatus/usage. Point HOME into tempDir so none of that reaches the
    // real home directory.
    const isolatedHome = path.join(tempDir, 'home');
    mkdirSync(isolatedHome, { recursive: true });

    child = trackedSpawn(NODE, [...TSX_FLAGS, APP_TS], {
      env: {
        ...process.env,
        HOME: isolatedHome,
        CORTEX_HOME: tempDir,
        CORTEX_PLATFORM: 'test',
        WEBHOOK_PORT: webhookPort,
        CORTEX_CLIENT_PORT: clientPort,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Wait for readiness signal (all modules now init before this log).
    // Adapter-name-agnostic: with CORTEX_PLATFORM=test the adapter may be a bare mock
    // OR a CompositeAdapter (name "composite") when TUI auto-enables alongside it, so
    // match the stable prefix rather than a specific "(mock)" suffix.
    const readySignal = 'Cortex agent is running';
    const ready = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 60_000);
      const check = () => {
        if (stdout.includes(readySignal)) {
          clearTimeout(timeout);
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    assert.ok(ready, `Server did not emit readiness signal within 60s.\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`);
    assert.match(stdout, /Startup: mounted \d+ hooks \(\d+ cc \/ \d+ cortex\)/);
    assert.match(stderr, /\[hook-registry\] skipped zz-invalid\.json/);
    assert.ok(existsSync(coreConfigPath), 'startup must recreate the core MCP config');
    const coreConfig = JSON.parse(readFileSync(coreConfigPath, 'utf-8'));
    assert.deepEqual(Object.keys(coreConfig.mcpServers), ['cortex-core']);

    const startPayload = await waitForPayload(startPayloadPath);
    assert.deepEqual(Object.keys(startPayload).sort(), ['pid', 'version']);
    assert.equal(startPayload.pid, child.pid);
    assert.equal(startPayload.version, JSON.parse(readFileSync(path.join(TEST_ROOT, 'package.json'), 'utf8')).version);

    // Send SIGTERM and wait for clean exit
    child.kill('SIGTERM');

    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL'); // force kill
        resolve(null);
      }, 15_000);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0, `Server exited with code ${exitCode} after SIGTERM.\nstderr: ${stderr.slice(0, 2000)}`);

    const shutdownPayload = await waitForPayload(shutdownPayloadPath);
    assert.deepEqual(Object.keys(shutdownPayload).sort(), ['pid', 'reason', 'version']);
    assert.equal(shutdownPayload.pid, child.pid);
    assert.equal(shutdownPayload.version, startPayload.version);
    assert.equal(shutdownPayload.reason, 'SIGTERM');

    // Both capture hooks exit non-zero after recording stdin. Reaching both captures,
    // readiness, and exit code 0 proves hook failure does not change host outcomes.
    assert.match(stdout, /Cortex agent is running/);
  } finally {
    if (child) killTree(child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test 3: Initialized environment has correct config content', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-int-'));
  try {
    await cortexInit(tempDir, 'claude\nnone\nn\nn\nn\nn\n');

    const state = JSON.parse(readFileSync(path.join(tempDir, 'data', 'agent-state.json'), 'utf-8'));
    assert.equal(state.backend, undefined);
    assert.equal(state.mode, undefined);
    assert.equal(state.claudeModel, undefined);
    assert.equal(state.activeProfile, undefined);
    assert.equal(state.defaultAgent, 'main');

    const models = JSON.parse(readFileSync(path.join(tempDir, 'config', 'models.json'), 'utf-8'));
    assert.equal(models.default.backend, 'claude');
    assert.equal(models.default.provider, null);
    assert.equal(typeof models.default.model, 'string');
    assert.ok(models.favorites.some(ref => ref.backend === models.default.backend && ref.model === models.default.model));
    assert.equal(existsSync(path.join(tempDir, 'config', 'profiles.json')), false);

    // The retired thread config is no longer seeded; environments are.
    assert.equal(existsSync(path.join(tempDir, 'config', 'thread-templates')), false);
    const environmentsDir = path.join(tempDir, 'config', 'environments');
    for (const name of readdirSync(environmentsDir).filter((f) => f.endsWith('.json'))) {
      JSON.parse(readFileSync(path.join(environmentsDir, name), 'utf-8'));
    }

    // Verify .env content
    const envContent = readFileSync(path.join(tempDir, 'config', '.env'), 'utf-8');
    const machineMatch = envContent.match(/^CORTEX_MACHINE=(.+)$/m);
    assert.ok(machineMatch, '.env should contain CORTEX_MACHINE');
    assert.equal(machineMatch![1], os.hostname(), 'CORTEX_MACHINE should match current hostname');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Test 4: cortex init with Slack platform writes Slack tokens to .env', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cortex-int-'));
  try {
    // stdin: backends, platform, gateway, name, org, email, installService, signing_secret, app_token, bot_token
    await cortexInit(tempDir, 'claude\nslack\nn\nn\nn\nn\nn\nsec123\nxapp-test-app\nxoxb-test-bot\n');

    const envContent = readFileSync(path.join(tempDir, 'config', '.env'), 'utf-8');
    assert.match(envContent, /^CORTEX_MACHINE=/m);
    assert.match(envContent, /^CORTEX_PLATFORM=slack/m);
    assert.match(envContent, /^SLACK_BOT_TOKEN=xoxb-test-bot/m);
    assert.match(envContent, /^SLACK_SIGNING_SECRET=sec123/m);
    assert.match(envContent, /^SLACK_APP_TOKEN=xapp-test-app/m);
    assert.doesNotMatch(envContent, /CORTEX_ADMIN_CHANNEL/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
