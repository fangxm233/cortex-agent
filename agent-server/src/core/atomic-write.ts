import fs from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { withFileLock } from './file-lock.js';
import { inTestProcess } from './test-process.js';

/** The operator's real homes: Cortex's data, PI's agent dir (shared with a separately installed
 *  `pi`) and the gateway's config. A test process must never write there — it would race the
 *  running daemon and leak fixtures into, or erase entries from, the live stores. Tests isolate via
 *  the vitest setup file (tests/_vitest-setup.ts), which repoints CORTEX_HOME at a per-file temp
 *  dir; a test that reaches files under the OS home must repoint HOME as well
 *  (tests/helpers/isolate-os-home.ts). Resolved once, at import, from the real home. */
const REAL_HOMES = ['.cortex', '.pi', '.aistatus'].map((dir) => path.join(os.homedir(), dir));

/**
 * Write `data` to `filePath` atomically via a sibling tmp file + fs.rename.
 * The original file is never in a partially-written state: either the rename
 * succeeds (new content visible) or it does not (original intact, tmp left on disk).
 */
/** Test-isolation tripwire shared by both variants: refuse (before writing anything) to mutate
 *  a real operator home from a test process. Converts silent production corruption into a loud
 *  failure. No-op in production (NODE_TEST_CONTEXT unset) and for temp-isolated test homes. */
function assertNotRealHomeInTest(filePath: string): void {
  if (!inTestProcess()) return;
  const resolved = path.resolve(filePath);
  const home = REAL_HOMES.find((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!home) return;
  throw new Error(
    `atomicWrite blocked: test process attempted to write under the real ${home} (${resolved}). `
    + `Isolate state first: run the test through vitest — \`npm test\` / \`npm run test:file <file>\` — `
    + `whose setup file points CORTEX_HOME at an isolated temp home; repoint HOME too for files under it.`,
  );
}

function throwIfWriteAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Atomic write aborted.');
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
  signal?: AbortSignal;
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
  await withFileLock(filePath, async () => {
    throwIfWriteAborted(options.signal);
    const contents = await readOptionalText(filePath);
    throwIfWriteAborted(options.signal);
    const updated = await mutate(contents);
    throwIfWriteAborted(options.signal);
    if (updated !== contents) await atomicWrite(filePath, updated, options);
    else if (options.mode !== undefined) await applyModeIfPresent(filePath, options.mode);
  }, { signal: options.signal });
}

export async function atomicWrite(
  filePath: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  assertNotRealHomeInTest(filePath);
  throwIfWriteAborted(options.signal);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  throwIfWriteAborted(options.signal);
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${rnd}`;
  let committed = false;
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: options.mode });
    throwIfWriteAborted(options.signal);
    if (options.mode !== undefined) await fs.chmod(tmp, options.mode);
    throwIfWriteAborted(options.signal);
    renameSync(tmp, filePath);
    committed = true;
  } finally {
    if (!committed) await fs.rm(tmp, { force: true });
  }
}

/** Synchronous variant for sync call sites (e.g. CLI write handlers). Same guard, same
 *  tmp+rename atomicity. */
export function atomicWriteSync(filePath: string, data: string, options: { mode?: number } = {}): void {
  assertNotRealHomeInTest(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${rnd}`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: options.mode });
  if (options.mode !== undefined) chmodSync(tmp, options.mode);
  renameSync(tmp, filePath);
}
