// input:  filePath, data string, optional permission mode
// output: atomic file write (tmp → rename), async and sync variants
// pos:    Write primitive that prevents partial file replacement
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

export interface AtomicWriteOptions {
  mode?: number;
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
  await fs.writeFile(tmp, data, 'utf8');
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
