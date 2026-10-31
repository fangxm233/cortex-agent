/** True only inside a test worker process: the runner sets NODE_TEST_CONTEXT (node:test does it
 *  implicitly, the vitest setup file sets it explicitly). Production code reads it only to refuse
 *  effects a test must never have, such as writing a real home or sending data off the machine. */
export function inTestProcess(): boolean {
  return !!process.env.NODE_TEST_CONTEXT;
}
