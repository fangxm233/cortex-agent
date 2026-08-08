import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** §18 (18.7)/(18.5) G5-R5 — X12's AUTHORITATIVE vehicle.
 *
 *  §7.3 X12 forbids the daemon webhook transport, but its subject is a **string literal** —
 *  `http://127.0.0.1:${process.env.WEBHOOK_PORT}` and `process.env.CORTEX_WEBHOOK_TOKEN` — which
 *  dependency-cruiser cannot see at all. The `benchmark-isolation-staged-x12-daemon-webhook` rule
 *  in `.dependency-cruiser.cjs` is a module-path stand-in and is explicitly NOT the rule. This is
 *  the rule: it reads the source of every module Gate 5 owns and fails if the literal returns.
 *
 *  The shipped carriers this exists to keep out are `domain/mcp/tools/thread-ops.ts:11,17` and
 *  `domain/mcp/tools/manager-qa.ts:9,16`; §7.2 P15 replaces both with an in-process control
 *  endpoint, so no benchmark module ever needs them. */

const REPO_SRC = new URL('../../../src/', import.meta.url).pathname;

/** `^src/domain/benchmark/` plus every `[NEW → …]` module this contract assigns to Gate 5 that
 *  lives outside it. */
const GATE5_MODULES_OUTSIDE_BENCHMARK = [
  'domain/threads/local-runtime-deps.ts',
  'domain/threads/local-runtime-defaults.ts',
];

const FORBIDDEN_LITERALS = ['127.0.0.1', 'WEBHOOK_PORT', 'CORTEX_WEBHOOK_TOKEN'];

function benchmarkModules(): string[] {
  const dir = path.join(REPO_SRC, 'domain/benchmark');
  return readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .map(name => path.join('domain/benchmark', name));
}

describe('§7.3 X12 — the daemon webhook literal (G5-R5)', () => {
  const modules = [...benchmarkModules(), ...GATE5_MODULES_OUTSIDE_BENCHMARK];

  it('covers every benchmark module plus Gate 5\'s modules outside that folder', () => {
    expect(modules.length).toBeGreaterThanOrEqual(18);
    expect(modules).toContain('domain/benchmark/composite-runtime-ports.ts');
    expect(modules).toContain('domain/threads/local-runtime-deps.ts');
  });

  it.each(FORBIDDEN_LITERALS)('carries no %s in any of them', (literal) => {
    const offenders = modules.filter(
      relative => readFileSync(path.join(REPO_SRC, relative), 'utf8').includes(literal),
    );
    expect(offenders).toEqual([]);
  });

  it('is a real check, not a vacuous one: it finds the literal in the shipped carriers', () => {
    const carrier = readFileSync(path.join(REPO_SRC, 'domain/mcp/tools/thread-ops.ts'), 'utf8');
    expect(FORBIDDEN_LITERALS.some(literal => carrier.includes(literal))).toBe(true);
  });
});
