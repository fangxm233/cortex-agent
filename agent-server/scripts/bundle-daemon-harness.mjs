/**
 * TEST ONLY; importing this file does not execute anything. Linux / Node >=22.19.
 * Parent must integrate production changes and prepare both NEW-CODE tarballs first.
 * No build/install/daemon is run by the fixture test suite.
 *
 * Callable API (run only after parent approval):
 *   import { runHarness } from './agent-server/scripts/bundle-daemon-harness.mjs';
 *   await runHarness({ scenario: 'rebuild', worktree: '/srv/cortex-worktree',
 *     testroot: '/tmp/cortex-bundle-rebuild-001', sourceTgz: '/tmp/source.tgz',
 *     bundleTgz: '/tmp/bundle.tgz' });
 * Scenarios: rebuild = source→bundled full→three fast samples→fallback full;
 * registry = independent 2026.10.21 prefix→bundle postinstall automatic restart;
 * startup-maps = install bundle, restore same-artifact maps from explicit mappedStage,
 *               five alternating off/on pairs of actual app starts + mapped error probe.
 * Set dryRun:true for validation/plan without mutation. Each execution needs a fresh root.
 * Results/logs remain there, including on failure. No credentials, provider turns or login.
 * The worktree needs preinstalled build tools/dependencies; the real daemon owns its builds.
 * npm networking is needed only when the parent runs installs. No global prefix is touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateOptions, claimRoot, isolatedEnv, preflight, createRunner, command,
  identity, sameProcess, now, readJson, saveJson, waitFor } from './bundle-daemon-runtime.mjs';
import { events, readProgress, appIdentity, verifyProgress, dependencySnapshot, digest,
  ready, stable, verifyArtifact, restoreMatchingMaps, publishedMaps } from './bundle-daemon-observe.mjs';

function context(options) {
  claimRoot(options.testroot);
  const env = isolatedEnv(options.testroot, options.scenario === 'rebuild' ? options.worktree : null,
    options.scenario === 'registry' ? 1 : 0);
  const packageRoot = path.join(env.CORTEX_NPM_PREFIX, 'lib/node_modules/@cortex-agent/server');
  const runner = createRunner(options.testroot, env);
  return { options, env, packageRoot, runner, results: { ok: false, scenario: options.scenario,
    startedAt: new Date().toISOString(), options, samples: [],
    tarballHashes: { source: digest(options.sourceTgz), bundle: digest(options.bundleTgz) } }, start: now() };
}

function persist(ctx) {
  ctx.results.totalMs = now() - ctx.start;
  saveJson(path.join(ctx.options.testroot, 'results.json'), ctx.results);
}

function saveSample(ctx, sample) {
  ctx.results.samples.push(sample);
  persist(ctx);
}

export async function runHarness(options) {
  validateOptions(options);
  if (options.dryRun) return { ok: true, dryRun: true, options, scenarios: ['rebuild', 'registry', 'startup-maps'] };
  const ctx = context(options);
  const handlers = installSignalHandlers(ctx);
  try {
    persist(ctx);
    await preflight(ctx.env);
    const scenarios = { rebuild: rebuildScenario, registry: registryScenario, 'startup-maps': startupMapsScenario };
    await scenarios[options.scenario](ctx);
    ctx.results.ok = true;
  } catch (error) {
    ctx.results.error = error.stack;
    throw error;
  } finally {
    await ctx.runner.close().catch(error => { ctx.results.ok = false; ctx.results.cleanupError = error.stack; });
    handlers.forEach(([name, handler]) => process.off(name, handler));
    ctx.results.finishedAt = new Date().toISOString();
    persist(ctx);
  }
  assert(ctx.results.ok, `Cleanup failed; inspect ${options.testroot}/results.json`);
  return ctx.results;
}

function installSignalHandlers(ctx) {
  return ['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => {
    const handler = () => {
      ctx.results.ok = false;
      ctx.results.error = `Interrupted by ${name}`;
      ctx.runner.close().finally(() => { persist(ctx); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[name]); });
    };
    process.once(name, handler);
    return [name, handler];
  });
}

async function install(ctx, artifact, label) {
  return command(ctx.runner, 'npm', ['install', '-g', '--prefix', ctx.env.CORTEX_NPM_PREFIX,
    '--foreground-scripts', artifact], label);
}

async function initialize(ctx) {
  await command(ctx.runner, path.join(ctx.env.CORTEX_NPM_PREFIX, 'bin/cortex'), ['init'], 'initialize-home');
  saveJson(path.join(ctx.env.CORTEX_HOME, 'config/settings.json'), { serverAutoUpdate: false, telemetryEnabled: false });
  // Initial npm installation wrote a trigger before any daemon existed; it is not a test rebuild.
  fs.rmSync(path.join(ctx.env.CORTEX_HOME, 'data/.restart'), { force: true });
}

async function startDaemon(ctx, label, overrides = {}) {
  const started = now();
  const daemon = ctx.runner.start(process.execPath, [path.join(ctx.packageRoot, 'dist/entry/daemon.js')], label, overrides);
  const app = await waitFor(() => {
    assert(sameProcess(daemon.identity), `Daemon exited; inspect ${daemon.logfile}`);
    const candidate = appIdentity(ctx.env);
    return candidate?.ppid === daemon.child.pid ? candidate : null;
  }, `${label} child PID`);
  const readiness = await ready(ctx.env, app, started);
  return { daemon, app, readiness };
}

async function trigger(ctx, label) {
  const result = await command(ctx.runner, path.join(ctx.env.CORTEX_NPM_PREFIX, 'bin/cortex'),
    ['daemon', 'restart'], `${label}-trigger`, 30000);
  // The watcher can consume/unlink .restart before the CLI exits; assert its acknowledgement instead.
  assert(fs.readFileSync(result.logfile, 'utf8').includes('Restart signal sent to daemon'), 'Missing CLI restart acknowledgement');
  return result;
}

async function awaitProgress(ctx, before, since, label) {
  const observed = [];
  let previous;
  const progress = await waitFor(() => {
    const next = readProgress(ctx.env);
    if (!next || next.startedAt === before?.startedAt) return null;
    const serialized = JSON.stringify(next);
    if (serialized !== previous) observed.push({ elapsedMs: now() - since, progress: next });
    previous = serialized;
    saveJson(path.join(ctx.options.testroot, `${label}-progress.json`), observed);
    assert(!['aborted', 'deferred'].includes(next.status), `Rebuild ${next.status}: ${serialized}`);
    return next.status === 'succeeded' ? next : null;
  }, `${label} progress`, 1200000);
  return { progress, observed };
}

async function awaitReplacement(ctx, daemon, oldApp, since) {
  const app = await waitFor(() => {
    assert(sameProcess(daemon.identity), 'Daemon PID/identity changed during rebuild');
    const next = appIdentity(ctx.env);
    return next?.ppid === daemon.child.pid && !sameProcess(oldApp, next) ? next : null;
  }, 'replacement app PID');
  await waitFor(() => !sameProcess(oldApp), 'old app to exit');
  return { app, readiness: await ready(ctx.env, app, since) };
}

async function rebuildOnce(ctx, daemon, label, bundled, fast) {
  const oldApp = appIdentity(ctx.env);
  const before = readProgress(ctx.env);
  const started = now();
  const cli = await trigger(ctx, label);
  const { progress } = await awaitProgress(ctx, before, started, label);
  assert.equal(progress.daemonPid, daemon.child.pid);
  const detail = verifyProgress(progress, bundled, fast);
  const { app, readiness } = await awaitReplacement(ctx, daemon, oldApp, started);
  const artifact = verifyArtifact(ctx.packageRoot, bundled);
  assert.equal(readiness.process.sourceMaps, false, 'Runtime source maps must remain opt-in after the startup comparison');
  const totalMs = readiness.healthyMs;
  const stability = await stable(ctx.env, daemon.identity, app, progress.startedAt);
  const sample = { label, totalMs, cli, before: { daemon: daemon.identity, app: oldApp },
    after: { daemon: identity(daemon.child.pid), app }, readiness, artifact, progress, ...detail, stability };
  saveSample(ctx, sample);
  return sample;
}

async function rebuildScenario(ctx) {
  await install(ctx, ctx.options.sourceTgz, 'install-source');
  await initialize(ctx);
  assert.notEqual(readJson(path.join(ctx.packageRoot, 'package.json')).cortexBundle, true, 'sourceTgz must be new-code SOURCE, not bundled');
  const initial = await startDaemon(ctx, 'source-daemon');
  saveSample(ctx, { label: 'initial-source', app: initial.app, daemon: initial.daemon.identity, readiness: initial.readiness });
  await rebuildOnce(ctx, initial.daemon, 'bundled-full', true, false);
  for (let index = 0; index < 3; index++) await fastSample(ctx, initial.daemon, index);
  await ctx.runner.stop(initial.daemon);
  await preflight(ctx.env);
  const fallback = await startDaemon(ctx, 'fallback-daemon', { CORTEX_REBUILD_BUNDLE: '0' });
  assert(readJson(path.join(ctx.packageRoot, 'package.json')).cortexBundle, 'Fallback daemon must start from bundled install');
  await rebuildOnce(ctx, fallback.daemon, 'unbundled-full', false, false);
}

async function fastSample(ctx, daemon, index) {
  const stale = ['dist/chunks/chunk-OLD-fixture.js', 'dist/stale-fixture.js'];
  stale.forEach(file => fs.writeFileSync(path.join(ctx.packageRoot, file), '// stale fixture\n'));
  const dependencies = dependencySnapshot(ctx.packageRoot);
  saveJson(path.join(ctx.options.testroot, `fast-${index}-dependencies.json`), dependencies);
  const beforePackage = readJson(path.join(ctx.packageRoot, 'package.json'));
  const sample = await rebuildOnce(ctx, daemon, `bundled-fast-${index + 1}`, true, true);
  stale.forEach(file => assert(!fs.existsSync(path.join(ctx.packageRoot, file)), `Fast install retained ${file}`));
  assert.deepEqual(dependencySnapshot(ctx.packageRoot), dependencies, 'Fast install changed dependency inode/hash');
  assert.deepEqual(sample.artifact.dependencies, beforePackage.dependencies);
  assert.deepEqual(sample.artifact.optionalDependencies, beforePackage.optionalDependencies);
  sample.dependenciesStable = true;
  sample.staleFilesRemoved = stale;
  persist(ctx);
}

async function registryScenario(ctx) {
  assert(!('CORTEX_REPO' in ctx.env), 'Registry scenario must not have CORTEX_REPO');
  await install(ctx, '@cortex-agent/server@2026.10.21', 'install-registry');
  await initialize(ctx);
  const initial = await startDaemon(ctx, 'registry-old-daemon');
  assert.equal(readJson(path.join(ctx.packageRoot, 'package.json')).version, '2026.10.21');
  const beforeProgress = readProgress(ctx.env);
  const started = now();
  const npm = await install(ctx, ctx.options.bundleTgz, 'install-bundle-upgrade');
  // Deliberately NO CLI restart/touch here: postinstall must trigger the old supervisor.
  const { app, readiness } = await awaitReplacement(ctx, initial.daemon, initial.app, started);
  const pkg = readJson(path.join(ctx.packageRoot, 'package.json'));
  assert.equal(pkg.cortexBundle, true);
  assert(fs.existsSync(path.join(ctx.packageRoot, 'dist/chunks')));
  assert.deepEqual(publishedMaps(ctx.packageRoot), [], 'npm bundle files must exclude maps (including vendor maps)');
  const totalMs = readiness.healthyMs;
  const stability = await stable(ctx.env, initial.daemon.identity, app, beforeProgress?.startedAt);
  saveSample(ctx, { label: 'registry-postinstall-upgrade', npm, totalMs, readiness, stability,
    before: { daemon: initial.daemon.identity, app: initial.app }, after: { daemon: identity(initial.daemon.child.pid), app } });
}

async function startupMapsScenario(ctx) {
  await install(ctx, ctx.options.bundleTgz, 'install-mapped-bundle');
  await initialize(ctx);
  const appFile = path.join(ctx.packageRoot, 'dist/entry/app.js');
  assert.deepEqual(publishedMaps(ctx.packageRoot), [], 'npm tarball must exclude maps before fixture restoration');
  const mapCount = restoreMatchingMaps(ctx.options.mappedStage, ctx.packageRoot);
  ctx.results.mappedArtifact = { appHash: digest(appFile), mapHash: digest(`${appFile}.map`), mapCount };
  for (let pair = 0; pair < 5; pair++) {
    const order = pair % 2 === 0 ? [false, true] : [true, false];
    for (const maps of order) await startupSample(ctx, appFile, pair, maps);
  }
  await mappingProbe(ctx, appFile);
}

async function startupSample(ctx, appFile, pair, maps) {
  await preflight(ctx.env);
  assert.equal(digest(appFile), ctx.results.mappedArtifact.appHash);
  assert.equal(digest(`${appFile}.map`), ctx.results.mappedArtifact.mapHash);
  const started = now();
  const label = `startup-pair-${pair + 1}-${maps ? 'on' : 'off'}`;
  const args = [...(maps ? ['--enable-source-maps'] : []), appFile];
  const app = ctx.runner.start(process.execPath, args, label);
  const readiness = await ready(ctx.env, app.identity, started);
  assert.equal(readiness.process.sourceMaps, maps);
  saveSample(ctx, { label, pair: pair + 1, maps, totalMs: readiness.healthyMs, app: app.identity, readiness });
  await ctx.runner.stop(app);
  await delay(250);
}

async function mappingProbe(ctx, appFile) {
  const entry = ctx.runner.start(process.execPath, ['--enable-source-maps', appFile], 'mapped-error-probe',
    { CORTEX_AGENT_CWD: path.join(ctx.options.testroot, 'nonexistent-agent-cwd') });
  await waitFor(() => entry.result, 'mapped error probe', 30000);
  assert.notEqual(entry.result.code, 0, 'Invalid fixture cwd must fail app startup');
  const probe = events(ctx.env).findLast(event => event.type === 'uncaught' && event.pid === entry.child.pid);
  const stack = probe?.stack ?? fs.readFileSync(entry.logfile, 'utf8');
  assert(stack.includes('CORTEX_AGENT_CWD'));
  assert(/(?:dist\/)?core\/paths\.js:\d+:\d+/.test(stack), 'Expected readable prebundle core/paths.js frame, not a minified chunk');
  saveSample(ctx, { label: 'mapped-error-probe', result: entry.result, stack, expectedSource: 'prebundle JavaScript (not TypeScript)' });
}
