// Test-only assertions and measurements. Raw progress/events remain in the fixture root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { identity, sameProcess, now, readJson, waitFor } from './bundle-daemon-runtime.mjs';

export function events(env) {
  if (!fs.existsSync(env.CORTEX_BUNDLE_EVENTS)) return [];
  const lines = fs.readFileSync(env.CORTEX_BUNDLE_EVENTS, 'utf8').split('\n');
  return lines.slice(0, -1).filter(Boolean).map(JSON.parse);
}

export function readProgress(env) {
  const file = path.join(env.CORTEX_HOME, 'data/daemon-rebuild.json');
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

export function appIdentity(env) {
  const file = path.join(env.CORTEX_HOME, 'data/daemon-child.pid');
  if (!fs.existsSync(file)) return null;
  return identity(Number(fs.readFileSync(file, 'utf8').trim()));
}

export function verifyProgress(progress, bundled, fast) {
  assert.equal(progress.status, 'succeeded', JSON.stringify(progress));
  const names = progress.steps.map(step => step.name);
  const install = progress.steps.find(step => step.name === 'install');
  const restart = progress.steps.find(step => step.name === 'restart');
  assert.equal(install?.status, 'done');
  assert.equal(restart?.status, 'done');
  assert(names.indexOf('install') < names.indexOf('restart'));
  if (bundled) assertBundleStep(progress, names);
  else assert(!progress.steps.some(step => step.name === 'bundle' && step.status !== 'skipped'), 'Fallback must not run bundling');
  const evidence = `${install.detail ?? ''} ${progress.detail ?? ''}`;
  assert(fast ? /\bfast\b/i.test(evidence) : /pack[\s\S]*install|install[\s\S]*pack/i.test(evidence), `Missing explicit ${fast ? 'fast' : 'pack/install'} evidence: ${evidence}`);
  return { install, stages: progress.steps.map(step => ({ ...step,
    elapsedMs: step.startedAt && step.endedAt ? Date.parse(step.endedAt) - Date.parse(step.startedAt) : null })) };
}

function assertBundleStep(progress, names) {
  assert.equal(progress.steps.find(step => step.name === 'bundle')?.status, 'done', 'Missing completed bundle phase');
  assert(names.indexOf('bundle') < names.indexOf('install'), 'bundle must precede install');
}

export function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(item => !item.isDirectory()).map(item => path.join(item.parentPath, item.name)).sort();
}

export function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function dependencySnapshot(packageRoot) {
  const root = path.join(packageRoot, 'node_modules');
  assert(fs.existsSync(root), `Missing installed dependencies: ${root}`);
  const snapshot = filesBelow(root).map(file => {
    const stat = fs.lstatSync(file);
    const hash = stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(file)}` : digest(file);
    return { file: path.relative(root, file), inode: stat.ino, device: stat.dev, hash };
  });
  assert(snapshot.length > 0, 'Dependency snapshot must not be empty');
  return snapshot;
}

async function get(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  return { status: response.status, text: await response.text() };
}

export async function health(env) {
  const base = `http://127.0.0.1:${env.CORTEX_UI_PORT}`;
  const spa = await get(`${base}/`);
  assert.equal(spa.status, 200); assert(/<html/i.test(spa.text), 'Missing SPA');
  const session = await get(`${base}/api/ui/session`);
  assert.equal(session.status, 200); JSON.parse(session.text);
  const url = `${base}/trpc/projects.list?input=%7B%7D`;
  assert.equal((await get(url)).status, 401, 'API must reject missing authentication');
  const api = await get(url, { 'x-cortex-token': env.CORTEX_CLIENT_TOKEN });
  assert.equal(api.status, 200); assert(JSON.parse(api.text).result);
  const gateway = await get(`http://127.0.0.1:${env.CORTEX_BUNDLE_GATEWAY_PORT}/health`);
  assert.equal(gateway.status, 200);
  return { spa: spa.status, session: session.status, api: api.status, gateway: gateway.status, at: new Date().toISOString() };
}

export function assertGuardEvidence(env, app) {
  const records = events(env);
  assert(!records.some(event => event.type === 'blocked-network'), 'Forbidden port access attempted; inspect events.jsonl');
  assert(records.some(event => event.type === 'gateway-remap' && event.pid === app.pid), 'Missing gateway remap marker for app');
  return records.findLast(event => event.type === 'process-start' && event.pid === app.pid);
}

export async function ready(env, app, since) {
  let lastHealthError;
  const result = await waitFor(async () => {
    assert(sameProcess(app), `App ${app?.pid} exited before becoming ready`);
    const boot = events(env).findLast(event => event.type === 'app-ready' && event.pid === app.pid && Number(event.monotonicNs) / 1e6 >= since);
    if (!boot) return null;
    try { return { boot, health: await health(env), appReadyMs: Number(boot.monotonicNs) / 1e6 - since, healthyMs: now() - since }; }
    catch (error) { lastHealthError = error.message; return null; }
  }, `app ${app?.pid} boot + health (see fixture logs)`).catch(error => { throw new Error(`${error.message}; last health: ${lastHealthError}`); });
  result.process = assertGuardEvidence(env, app);
  return result;
}

export async function stable(env, daemon, app, progressStartedAt, durationMs = 10000) {
  const start = now();
  while (now() - start < durationMs) {
    assert(sameProcess(daemon), 'Daemon identity changed');
    assert(sameProcess(app) && sameProcess(app, appIdentity(env)), 'App restarted again during stability window');
    assert.equal(readProgress(env)?.startedAt, progressStartedAt, 'Unexpected extra rebuild (postinstall feedback?)');
    await health(env);
    await delay(500);
  }
  assertGuardEvidence(env, app);
  return { elapsedMs: now() - start, daemon: identity(daemon.pid), app: identity(app.pid) };
}

export function verifyArtifact(packageRoot, bundled) {
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  assert.equal(pkg.cortexBundle === true, bundled, 'Unexpected installed bundle marker');
  if (!bundled) assert(!Object.hasOwn(pkg, 'cortexBundle'), 'Fallback must remove the bundle marker');
  const chunks = path.join(packageRoot, 'dist/chunks');
  assert.equal(fs.existsSync(chunks), bundled, 'Unexpected chunk directory');
  if (bundled) assert(fs.existsSync(path.join(packageRoot, 'dist/entry/app.js.map')), 'Daemon must restore app map');
  return { version: pkg.version, cortexBundle: pkg.cortexBundle ?? false,
    dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies };
}

export function publishedMaps(packageRoot) {
  return fs.readdirSync(packageRoot, { withFileTypes: true }).filter(entry => entry.name !== 'node_modules')
    .flatMap(entry => entry.isDirectory() ? filesBelow(path.join(packageRoot, entry.name)) : [path.join(packageRoot, entry.name)])
    .filter(file => file.endsWith('.map'));
}

export function restoreMatchingMaps(stage, packageRoot) {
  const maps = publishedMaps(stage).filter(file => file.endsWith('.js.map'));
  assert(maps.length > 0, 'mappedStage has no JS maps; produce bundle.mjs <stage> --sourcemap first');
  for (const map of maps) {
    const relative = path.relative(stage, map);
    const installedJs = path.join(packageRoot, relative.slice(0, -4));
    assert.equal(digest(map.slice(0, -4)), digest(installedJs), `Map JS mismatch: ${relative}`);
    fs.copyFileSync(map, path.join(packageRoot, relative));
  }
  assert(fs.existsSync(path.join(packageRoot, 'dist/entry/app.js.map')), 'Missing installed app map');
  return maps.length;
}
