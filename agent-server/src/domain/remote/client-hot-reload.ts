// input:  client repo builds (dev) or the npm registry client package (release)
// output: bundle pushes over device WebSockets and convergence notices
// pos:    Publishes the desired client bundle; each device installs it itself
// >>> If I am updated, update CORTEX.md <<<
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import {
  setClientUpdateHooks,
  getOnlineDevices,
  sendControlMessage,
} from './client-manager.js';
import { STORE_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../core/icons.js';

const log = createLogger('client-hot-reload');

/** The complete update artifact, hashed in this exact order on both ends. */
const BUNDLE_FILES = ['client.mjs', 'cortex-run-watcher.mjs'];

/** After a failed install, do not re-push the same bundle to that device for this long. */
const PUSH_RETRY_COOLDOWN_MS = 10 * 60_000;
/** An unanswered push is considered in-flight (no re-push) for this long. */
const PUSH_INFLIGHT_MS = 2 * 60_000;

// --- Types ---

interface ClientBundle {
  version: string;
  hash: string;
  files: Array<{ name: string; data: string }>; // data is base64
}

interface PushAttempt {
  hash: string;
  at: number;
  /** null = in flight, false = install failed, true = installed (awaiting reconnect). */
  ok: boolean | null;
}

// --- State ---

let _bundle: ClientBundle | null = null;
const _lastPush = new Map<string, PushAttempt>();
let _notify: (text: string) => void = () => {};

// --- Mode detection ---

function isDevMode(): boolean {
  const repo = process.env.CORTEX_REPO;
  if (!repo) return false;
  try {
    return fs.existsSync(repo) && fs.statSync(repo).isDirectory();
  } catch {
    return false;
  }
}

function resolveClientRepo(): string | null {
  // Explicit override
  if (process.env.CORTEX_CLIENT_REPO) {
    const p = process.env.CORTEX_CLIENT_REPO;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch {}
  }

  // Derive from CORTEX_REPO (sibling directory)
  const repo = process.env.CORTEX_REPO;
  if (!repo) return null;
  const clientPath = path.resolve(repo, '..', 'client');
  try {
    if (fs.existsSync(clientPath) && fs.statSync(clientPath).isDirectory()) return clientPath;
  } catch {}
  return null;
}

// --- Bundle resolution ---

function loadBundleFromDir(dir: string, version: string): ClientBundle | null {
  const files: Array<{ name: string; data: string }> = [];
  const h = crypto.createHash('sha256');
  for (const name of BUNDLE_FILES) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    h.update(buf);
    files.push({ name, data: buf.toString('base64') });
  }
  return { version, hash: h.digest('hex'), files };
}

/** Dev mode: bundle straight from the client repo (esbuild, sub-second). */
function buildDevBundle(): ClientBundle | null {
  const repo = resolveClientRepo();
  if (!repo) {
    log.warn('Dev mode: client repo not found — client hot-reload idle');
    return null;
  }
  try {
    const start = Date.now();
    execSync('npm run bundle', { cwd: repo, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
    log.info(`Client bundle built in ${Date.now() - start}ms`);
  } catch (err) {
    log.error(`Client bundle build failed: ${(err as Error).message}`);
    return null;
  }
  let version = 'dev';
  try {
    version = `${JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version}-dev`;
  } catch {}
  return loadBundleFromDir(path.join(repo, 'dist'), version);
}

/** Release mode: latest published client package, bundle files cached per version. */
function fetchReleaseBundle(): ClientBundle | null {
  let version = '';
  try {
    version = execSync('npm view @cortex-agent/client version', {
      encoding: 'utf8', timeout: 30000, stdio: 'pipe',
    }).trim();
  } catch (err) {
    log.warn(`Release mode: npm registry unreachable — client hot-reload idle (${(err as Error).message})`);
    return null;
  }
  if (!version) return null;

  const cacheDir = path.join(STORE_DIR, 'client-bundles', version);
  const cached = loadBundleFromDir(cacheDir, version);
  if (cached) return cached;

  let tmp: string | null = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-client-bundle-'));
    execSync(`npm pack @cortex-agent/client@${version}`, { cwd: tmp, encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no tgz');
    execSync(`tar -xzf ${JSON.stringify(tgz)}`, { cwd: tmp, encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const name of BUNDLE_FILES) {
      fs.copyFileSync(path.join(tmp, 'package', 'dist', name), path.join(cacheDir, name));
    }
  } catch (err) {
    log.error(`Release mode: failed to fetch client ${version}: ${(err as Error).message}`);
    return null;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return loadBundleFromDir(cacheDir, version);
}

function resolveBundle(): ClientBundle | null {
  return isDevMode() ? buildDevBundle() : fetchReleaseBundle();
}

// --- Push decision ---

/** Pure decision: push when the device diverges, unless the same bundle is in
 *  flight or recently failed on that device. */
function shouldPush(
  reported: string | null,
  bundleHash: string,
  last: PushAttempt | undefined,
  now: number,
): boolean {
  if (reported === bundleHash) return false;
  if (last && last.hash === bundleHash) {
    if (last.ok === false && now - last.at < PUSH_RETRY_COOLDOWN_MS) return false;
    if (last.ok === null && now - last.at < PUSH_INFLIGHT_MS) return false;
    if (last.ok === true && now - last.at < PUSH_INFLIGHT_MS) return false; // installed, awaiting respawn+reconnect
  }
  return true;
}

function short(hash: string | null): string {
  return hash ? hash.slice(0, 12) : 'none';
}

// Injectable so tests exercise push decisions without a live WebSocket.
type SendControl = (device: string, message: Record<string, unknown>) => void;
let _send: SendControl = sendControlMessage;

function pushTo(device: string): void {
  if (!_bundle) return;
  _send(device, {
    type: 'update',
    updateId: crypto.randomBytes(6).toString('hex'),
    version: _bundle.version,
    hash: _bundle.hash,
    files: _bundle.files,
  });
  _lastPush.set(device, { hash: _bundle.hash, at: Date.now(), ok: null });
  log.info(`Pushed bundle ${short(_bundle.hash)} (v${_bundle.version}) to ${device}`);
}

// --- Hooks (wired into client-manager) ---

function onHello(device: string, bundleHash: string | null): void {
  if (!_bundle) return; // bundle still resolving; the post-resolve sweep covers this hello
  if (bundleHash === _bundle.hash) {
    const last = _lastPush.get(device);
    if (last && last.hash === _bundle.hash) {
      _lastPush.delete(device);
      log.info(`${device} converged on ${short(_bundle.hash)} (v${_bundle.version})`);
      _notify(`${Icons.ok} client on \`${device}\` updated → \`${short(_bundle.hash)}\` (v${_bundle.version})`);
    }
    return;
  }
  if (!shouldPush(bundleHash, _bundle.hash, _lastPush.get(device), Date.now())) return;
  try {
    pushTo(device);
  } catch (err) {
    log.warn(`Push to ${device} failed: ${(err as Error).message}`);
  }
}

function onUpdateResult(device: string, result: { ok: boolean; hash?: string; error?: string }): void {
  const last = _lastPush.get(device);
  if (last) last.ok = result.ok;
  if (result.ok) {
    log.info(`${device} installed ${short(result.hash ?? null)} — awaiting reconnect`);
  } else {
    log.warn(`${device} update failed: ${result.error ?? 'unknown error'}`);
    _notify(`${Icons.error} client update failed on \`${device}\`: ${result.error ?? 'unknown error'}`);
  }
}

// --- Entry ---

/**
 * Register the update hooks (synchronously, before devices say hello), then
 * resolve the desired bundle and sweep devices that connected meanwhile.
 * From then on every hello is compared against the bundle hash — reconnecting
 * or newly bootstrapped devices converge without any scheduled job.
 */
function initClientHotReload(notify: (text: string) => void): void {
  _notify = notify;
  setClientUpdateHooks({ onHello, onUpdateResult });
  setImmediate(() => {
    const bundle = resolveBundle();
    if (!bundle) return;
    _bundle = bundle;
    log.info(`Client bundle ready: ${short(bundle.hash)} (v${bundle.version})`);
    for (const d of getOnlineDevices()) onHello(d.device, d.bundleHash);
  });
}

// --- Test hooks ---

function _setBundleForTesting(bundle: ClientBundle | null): void { _bundle = bundle; }
function _setSendForTesting(fn: SendControl): void { _send = fn; }
function _setNotifyForTesting(fn: (text: string) => void): void { _notify = fn; }
function _testReset(): void {
  _bundle = null;
  _lastPush.clear();
  _notify = () => {};
  _send = sendControlMessage;
}

export {
  initClientHotReload,
  resolveBundle,
  loadBundleFromDir,
  shouldPush,
  onHello as _onHelloForTesting,
  onUpdateResult as _onUpdateResultForTesting,
  _setBundleForTesting,
  _setSendForTesting,
  _setNotifyForTesting,
  _testReset,
};
export type { ClientBundle, PushAttempt };
