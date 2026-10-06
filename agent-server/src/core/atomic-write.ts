import fs from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { withFileLock } from './file-lock.js';

/** The operator's real data home. A test process must never write here — it would race the
 *  running daemon and leak fixtures into the live store. Tests isolate via the vitest setup file
 *  (tests/_vitest-setup.ts), which repoints CORTEX_HOME at a per-file temp dir, so legitimate test
 *  writes land elsewhere and pass this guard. */
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
      + `Isolate state first: run the test through vitest — \`npm test\` / \`npm run test:file <file>\` — `
      + `whose setup file points CORTEX_HOME at an isolated temp home.`,
    );
  }
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
export function atomicWriteSync(filePath: string, data: string): void {
  assertNotRealHomeInTest(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const rnd = Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${rnd}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, filePath);
}
