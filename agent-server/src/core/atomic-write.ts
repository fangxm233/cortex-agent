// input:  file paths, text mutations, optional permission mode
// output: atomic writes and cross-process serialized mutations
// pos:    Safe file replacement and mutation primitive
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';

/** The operator's real data home. A test process must never write here — it would race the
 *  running daemon and leak fixtures into the live store (this happened: tests polluted
 *  ~/.cortex/data/threads.json). Tests isolate via tests/_test-home.ts, which repoints
 *  CORTEX_HOME at a temp dir, so legitimate test writes land elsewhere and pass this guard. */
const REAL_HOME_CORTEX = path.join(os.homedir(), '.cortex');

/** True only inside `node --test` / `tsx --test` worker processes (env set by the runner). */
function inTestProcess(): boolean {
  return !!process.env.NODE_TEST_CONTEXT;
}

/**
 * Write `data` to `filePath` atomically via a sibling tmp file + fs.rename.
 * The original file is never in a partially-written state: either the rename
 * succeeds (new content visible) or it does not (original intact, tmp left on disk).
 */
/** Test-isolation tripwire shared by both variants: refuse (before writing anything) to mutate
 *  the real ~/.cortex from a test process. Converts silent production corruption into a loud
 *  failure. No-op in production (NODE_TEST_CONTEXT unset) and for temp-isolated test homes. */
function assertNotRealHomeInTest(filePath: string): void {
  if (!inTestProcess()) return;
  const resolved = path.resolve(filePath);
  if (resolved === REAL_HOME_CORTEX || resolved.startsWith(REAL_HOME_CORTEX + path.sep)) {
    throw new Error(
      `atomicWrite blocked: test process attempted to write under the real ~/.cortex (${resolved}). `
      + `Isolate state first: import './_test-home.js' as the FIRST line of the test, or run via `
      + `\`npm test\` / \`npm run test:file <file>\` (both set an isolated CORTEX_HOME).`,
    );
  }
}

const MUTATION_LOCK_WAIT_MS = 10;
const MUTATION_LOCK_TIMEOUT_MS = 30_000;
const OWNERLESS_LOCK_GRACE_MS = 1_000;

interface MutationLockOwner {
  pid: number;
  token: string;
  processStart: string | null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

async function processStartIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

async function readLockOwner(lockPath: string): Promise<MutationLockOwner | null> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (typeof owner.pid !== 'number' || typeof owner.token !== 'string') return null;
    return {
      pid: owner.pid,
      token: owner.token,
      processStart: typeof owner.processStart === 'string' ? owner.processStart : null,
    };
  } catch {
    return null;
  }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  let ageMs: number;
  try { ageMs = Date.now() - (await fs.stat(lockPath)).mtimeMs; } catch { return false; }
  const owner = await readLockOwner(lockPath);
  if (!owner) return ageMs > OWNERLESS_LOCK_GRACE_MS;
  if (!processIsAlive(owner.pid)) return true;
  const currentStart = await processStartIdentity(owner.pid);
  return owner.processStart !== null && currentStart !== null && owner.processStart !== currentStart;
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  if ((await readLockOwner(lockPath))?.token !== token) return;
  const releasedPath = `${lockPath}.released.${encodeURIComponent(token)}`;
  try {
    await fs.rename(lockPath, releasedPath);
    if ((await readLockOwner(releasedPath))?.token === token) {
      await fs.rm(releasedPath, { recursive: true, force: true });
    }
  } catch {}
}

async function removeStaleLock(lockPath: string): Promise<void> {
  if (!(await lockIsStale(lockPath))) return;
  try {
    const initial = await fs.stat(lockPath);
    await fs.writeFile(path.join(lockPath, '.reclaimed'), '');
    const current = await fs.stat(lockPath);
    if (current.dev !== initial.dev || current.ino !== initial.ino) return;
    if ((await readLockOwner(lockPath)) && !(await lockIsStale(lockPath))) return;
    const identity = `${current.dev}.${current.ino}.${String(current.ctimeMs).replace('.', '-')}`;
    const tombstone = `${lockPath}.reclaimed.${identity}`;
    await fs.rename(lockPath, tombstone);
    await fs.rm(tombstone, { recursive: true, force: true });
  } catch {}
}

async function tryAcquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const candidate = `${lockPath}.candidate.${encodeURIComponent(token)}`;
  try {
    await fs.mkdir(candidate);
    const owner: MutationLockOwner = {
      pid: process.pid, token, processStart: await processStartIdentity(process.pid),
    };
    await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    await fs.rename(candidate, lockPath);
    return () => releaseOwnedLock(lockPath, token);
  } catch (error: any) {
    await fs.rm(candidate, { recursive: true, force: true });
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return null;
    throw error;
  }
}

async function acquireMutationLock(filePath: string): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.mutation-lock`;
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const release = await tryAcquireLock(lockPath);
    if (release) return release;
    if (await lockIsStale(lockPath)) await removeStaleLock(lockPath);
    else await new Promise(resolve => setTimeout(resolve, MUTATION_LOCK_WAIT_MS));
  }
  throw new Error('Timed out waiting for file mutation lock.');
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export interface AtomicWriteOptions {
  mode?: number;
}

async function applyModeIfPresent(filePath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function mutateFileAtomically(
  filePath: string,
  mutate: (contents: string) => string | Promise<string>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  assertNotRealHomeInTest(filePath);
  const release = await acquireMutationLock(filePath);
  try {
    const contents = await readOptionalText(filePath);
    const updated = await mutate(contents);
    if (updated !== contents) await atomicWrite(filePath, updated, options);
    else if (options.mode !== undefined) await applyModeIfPresent(filePath, options.mode);
  } finally {
    await release();
  }
}

export async function atomicWrite(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  assertNotRealHomeInTest(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${rnd}`;
  await fs.writeFile(tmp, data, { encoding: 'utf8', mode: options.mode });
  if (options.mode !== undefined) await fs.chmod(tmp, options.mode);
  await fs.rename(tmp, filePath);
}

/** Synchronous variant for sync call sites (e.g. CLI write handlers). Same guard, same
 *  tmp+rename atomicity. */
export function atomicWriteSync(filePath: string, data: string): void {
  assertNotRealHomeInTest(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${rnd}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, filePath);
}
