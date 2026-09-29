import type { Result } from '../types.js';

type KnownCode = 'invalid-args' | 'not-found' | 'conflict';

export function fail(code: KnownCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Writer errors carry `code`; anything else is a genuine internal failure. `conflict` reaches the
 *  UI intact so the editor can offer a reload instead of a generic failure toast. */
export function toErr(error: unknown): Result<never> {
  const code = (error as { code?: unknown })?.code;
  const known = code === 'not-found' || code === 'invalid-args' || code === 'conflict';
  return {
    ok: false,
    code: known ? String(code) : 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}
