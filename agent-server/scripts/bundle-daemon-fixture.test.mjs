// Pure/small fixtures only: never installs a package, builds, or starts Cortex.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { guardedPort } from './bundle-daemon-guards.mjs';
import { isolatedEnv, validateOptions, claimRoot, createRunner, identity, sameProcess, waitFor } from './bundle-daemon-runtime.mjs';
import { verifyProgress, dependencySnapshot, restoreMatchingMaps, events, verifyArtifact, publishedMaps } from './bundle-daemon-observe.mjs';
import { runHarness } from './bundle-daemon-harness.mjs';

test('builtin argument normalization finds forbidden TCP/UDP forms', () => {
  for (const args of [[9880], ['9880', 'localhost'], [{ port: 9880 }], [[{ port: '9880' }]]]) {
    assert.equal(guardedPort(args), 9880);
  }
  assert.equal(guardedPort(['/tmp/socket']), null);
});

function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bundle-fixture-')); }

test('environment is allowlisted, all mutable homes and npm config are isolated', () => {
  const root = fixture();
  const env = isolatedEnv(root, '/fixture/worktree', 0);
  assert.equal(env.CORTEX_REPO, '/fixture/worktree/agent-server');
  assert.equal(env.CORTEX_TELEMETRY, '0');
  assert.equal(env.CORTEX_NPM_PREFIX, env.npm_config_prefix);
  assert(!('CORTEX_REPO' in isolatedEnv(fixture(), null, 1)));
  assert(!('OPENAI_API_KEY' in env) && !('SSH_AUTH_SOCK' in env));
  for (const key of ['HOME', 'CORTEX_HOME', 'CORTEX_NPM_PREFIX', 'npm_config_userconfig', 'npm_config_globalconfig']) {
    assert(env[key].startsWith(root + '/'), key);
  }
});

test('fresh root and explicit input validation reject unsafe reuse', () => {
  assert.throws(() => claimRoot('/home/not-a-fixture'));
  const root = fixture();
  assert.throws(() => claimRoot(root), /fresh|exist/i);
  assert.throws(() => validateOptions({ scenario: 'unknown' }), /scenario/i);
});

test('progress uses broad evidence, but requires successful ordered bundle/install/restart', () => {
  const progress = { status: 'succeeded', steps: ['server', 'bundle', 'install', 'restart'].map(name => ({ name, status: 'done', detail: null })) };
  progress.steps[2].detail = 'bundled fast sync';
  assert.equal(verifyProgress(progress, true, true).install.detail, 'bundled fast sync');
  assert.throws(() => verifyProgress(progress, true, false));
  progress.steps[2].detail = 'bundle-full';
  assert.doesNotThrow(() => verifyProgress(progress, true, false));
  progress.steps[2].detail = 'pack + install -g';
  assert.doesNotThrow(() => verifyProgress(progress, true, false));
  progress.steps.reverse();
  assert.throws(() => verifyProgress(progress, true, false));
});

test('dependency snapshot detects changed inode even when content is identical', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/dep/index.js'), 'export default 1;');
  const before = dependencySnapshot(root);
  fs.renameSync(path.join(root, 'node_modules/dep/index.js'), path.join(root, 'old.js'));
  fs.writeFileSync(path.join(root, 'node_modules/dep/index.js'), 'export default 1;');
  assert.notDeepEqual(dependencySnapshot(root), before);
});

test('real Node preload blocks builtin 9880 calls before networking and records evidence', () => {
  const root = fixture();
  const env = isolatedEnv(root, '/fixture/worktree', 0);
  const preload = pathToFileURL(path.resolve(import.meta.dirname, 'bundle-daemon-preload.mjs')).href;
  const script = `const net=require('node:net'); const dgram=require('node:dgram');
    for(const action of [()=>net.connect(9880),()=>net.createServer().listen({port:9880}),()=>dgram.createSocket('udp4').connect(9880)]) {
      require('node:assert/strict').throws(action, /9880/);
    }`;
  const result = spawnSync(process.execPath, ['--import', preload, '-e', script], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const events = fs.readFileSync(env.CORTEX_BUNDLE_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.type === 'blocked-network').length, 3);
});

test('preload records configured gateway settings and boot timing without rewriting source', () => {
  const root = fixture();
  const env = isolatedEnv(root, null);
  const script = `if(process.env.CORTEX_GATEWAY_PORT!=='9781')throw Error('wrong port');console.log('boot 11ms (imports 7ms)');`;
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const records = events(env);
  assert.equal(records.find(event => event.type === 'process-start').gatewayPort, 9781);
  assert.equal(records.find(event => event.type === 'app-ready').importsMs, 7);
});

test('smoke and turn guards refuse unsafe ports and block direct live-port access', () => {
  const env = isolatedEnv(fixture(), null);
  env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(import.meta.dirname, 'bundle-smoke-preload.mjs')).href}`;
  const script = `require('node:assert/strict').throws(()=>require('node:net').connect(9880), /9880/);`;
  assert.equal(spawnSync(process.execPath, ['-e', script], { env }).status, 0);
  for (const port of ['9880', '0', 'NaN']) {
    assert.notEqual(spawnSync(process.execPath, ['-e', ''], { env: { ...env, CORTEX_GATEWAY_PORT: port } }).status, 0);
  }
});

test('maps may only be restored alongside byte-identical installed JS', () => {
  const root = fixture();
  const stage = path.join(root, 'stage');
  const installed = path.join(root, 'installed');
  for (const base of [stage, installed]) {
    fs.mkdirSync(path.join(base, 'dist/entry'), { recursive: true });
    fs.writeFileSync(path.join(base, 'dist/entry/app.js'), 'export default 1;');
  }
  fs.writeFileSync(path.join(stage, 'dist/entry/app.js.map'), '{"version":3}');
  assert.equal(restoreMatchingMaps(stage, installed), 1);
  fs.writeFileSync(path.join(installed, 'dist/entry/app.js'), 'export default 2;');
  assert.throws(() => restoreMatchingMaps(stage, installed), /mismatch/);
});

test('fallback requires absent marker, and published-map checks include vendor but exclude dependencies', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'package.json'), '{"cortexBundle":false}');
  assert.throws(() => verifyArtifact(root, false), /remove the bundle marker/);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.doesNotThrow(() => verifyArtifact(root, false));
  for (const relative of ['vendor/pi/app.js.map', 'node_modules/dep/app.js.map']) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
  }
  assert.deepEqual(publishedMaps(root), [path.join(root, 'vendor/pi/app.js.map')]);
});

test('callable dry run validates but never creates root or starts subprocesses', async () => {
  const fixtureRoot = fixture();
  fs.mkdirSync(path.join(fixtureRoot, 'agent-server'));
  fs.writeFileSync(path.join(fixtureRoot, 'agent-server/package.json'), '{}');
  const tgz = path.join(fixtureRoot, 'unused.tgz');
  fs.writeFileSync(tgz, 'not an archive: dry run must not install it');
  const testroot = `${fixtureRoot}-dry-run`;
  const result = await runHarness({ worktree: fixtureRoot, testroot, sourceTgz: tgz, bundleTgz: tgz, scenario: 'rebuild', dryRun: true });
  assert.equal(result.ok, true);
  assert(!fs.existsSync(testroot));
});

test('cleanup stops owned detached fixture descendants, not unrelated processes', async () => {
  const root = fixture();
  const env = isolatedEnv(root, null);
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: isolatedEnv(fixture(), null), stdio: 'ignore' });
  const outsiderIdentity = identity(outsider.pid);
  const runner = createRunner(root, env);
  try {
    const code = `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,detached:true,stdio:'ignore'});setInterval(()=>{},1000);`;
    const entry = runner.start(process.execPath, ['-e', code], 'fixture-parent');
    await waitFor(() => events(env).filter(event => event.type === 'process-start').length === 2, 'fixture descendant', 5000);
    const children = events(env).filter(event => event.type === 'process-start').map(event => identity(event.pid));
    await runner.close();
    assert(children.every(child => !sameProcess(child)));
    assert(!sameProcess(entry.identity));
    assert(sameProcess(outsiderIdentity));
    assert.throws(() => runner.start(process.execPath, [], 'after-close'), /closing/);
  } finally {
    await runner.close();
    outsider.kill('SIGTERM');
    await waitFor(() => !sameProcess(outsiderIdentity), 'outsider fixture exit', 5000);
  }
});
