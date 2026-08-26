// input:  server 'update' messages, own bundle files
// output: verified bundle install under DATA_DIR/client and process re-exec
// pos:    Client self-update — the client owns its environment; the server only ships bytes
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { DATA_DIR } from './paths.js';
import { createLogger } from './log.js';

const log = createLogger('self-update');

/** Managed install root: DATA_DIR/client/{current,previous,next}/ — fixed paths, no symlinks. */
export const CLIENT_INSTALL_DIR = path.join(DATA_DIR, 'client');

/** The complete update artifact, hashed in this exact order on both ends. */
export const BUNDLE_FILES = ['client.mjs', 'cortex-run-watcher.mjs'] as const;

export interface UpdateMessage {
  type: 'update';
  updateId?: string;
  version?: string;
  hash: string;
  files: Array<{ name: string; data: string }>; // data is base64
}

export interface UpdateIo {
  sendResult: (ok: boolean, error?: string) => void;
  closeWs: () => void;
  respawn: (entryPath: string) => void;
  exit: (code: number) => void;
}

/** sha256 over the artifact set in a directory, or null if any file is missing. */
export function hashBundleFiles(dir: string): string | null {
  const h = crypto.createHash('sha256');
  for (const name of BUNDLE_FILES) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return null;
    h.update(fs.readFileSync(p));
  }
  return h.digest('hex');
}

/**
 * Identity reported in hello. A managed install hashes the artifact set beside its
 * own entry file; anything else (repo dist, npm install) falls back to hashing the
 * entry file alone — which can never equal an artifact hash, so unmanaged clients
 * are adopted into the managed layout on their first hello.
 */
export function computeSelfBundleHash(entryPath = process.argv[1]): string {
  if (!entryPath) return 'unknown';
  const entry = path.resolve(entryPath);
  const setHash = hashBundleFiles(path.dirname(entry));
  if (setHash) return setHash;
  try {
    return `entry-${crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex')}`;
  } catch {
    return 'unknown';
  }
}

function validateUpdateMessage(msg: UpdateMessage): string | null {
  if (typeof msg.hash !== 'string' || !msg.hash) return 'missing hash';
  if (!Array.isArray(msg.files)) return 'missing files';
  for (const name of BUNDLE_FILES) {
    if (!msg.files.some((f) => f && f.name === name && typeof f.data === 'string')) {
      return `missing file: ${name}`;
    }
  }
  return null;
}

/** rm previous; current→previous; next→current. On failure, restore current. */
function swapDirs(root: string): void {
  const next = path.join(root, 'next');
  const current = path.join(root, 'current');
  const previous = path.join(root, 'previous');
  fs.rmSync(previous, { recursive: true, force: true });
  const hadCurrent = fs.existsSync(current);
  if (hadCurrent) fs.renameSync(current, previous);
  try {
    fs.renameSync(next, current);
  } catch (err) {
    if (hadCurrent) {
      try { fs.renameSync(previous, current); } catch {}
    }
    throw err;
  }
}

export function defaultRespawn(entryPath: string): void {
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

/**
 * Install an update pushed by the server: write to next/, verify the hash, rotate
 * current→previous, report the result, then close the socket (frees the device
 * name server-side), spawn the successor from current/ and exit. Any failure
 * leaves the running version in place — the device never goes offline over a
 * failed update.
 */
export function handleUpdateMessage(msg: UpdateMessage, io: UpdateIo): void {
  const invalid = validateUpdateMessage(msg);
  if (invalid) {
    io.sendResult(false, invalid);
    return;
  }

  try {
    const next = path.join(CLIENT_INSTALL_DIR, 'next');
    fs.rmSync(next, { recursive: true, force: true });
    fs.mkdirSync(next, { recursive: true });
    for (const name of BUNDLE_FILES) {
      const file = msg.files.find((f) => f.name === name)!;
      fs.writeFileSync(path.join(next, name), Buffer.from(file.data, 'base64'), { mode: 0o755 });
    }
    const got = hashBundleFiles(next);
    if (got !== msg.hash) {
      fs.rmSync(next, { recursive: true, force: true });
      io.sendResult(false, `hash mismatch: expected ${msg.hash}, got ${got}`);
      return;
    }
    swapDirs(CLIENT_INSTALL_DIR);
  } catch (err) {
    io.sendResult(false, (err as Error).message);
    return;
  }

  log.info(`Installed bundle ${msg.hash.slice(0, 12)}${msg.version ? ` (v${msg.version})` : ''} — restarting`);
  io.sendResult(true);

  // Stagger: let the result frame flush, close so the server frees the device
  // name, then spawn the successor and exit. If the successor fails to start,
  // the server's SSH supervision relaunches from current/ (manual rescue:
  // mv previous current).
  setTimeout(() => {
    try { io.closeWs(); } catch {}
    setTimeout(() => {
      try {
        io.respawn(path.join(CLIENT_INSTALL_DIR, 'current', 'client.mjs'));
      } catch (err) {
        log.error(`Respawn failed: ${(err as Error).message}`);
      }
      io.exit(0);
    }, 400);
  }, 400);
}
