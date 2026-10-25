/** Small helpers shared by the maintainer scripts (Node, run through tsx). */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class CliError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

/** File contents, or stdin for `-`. */
export function readInput(path: string): string {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Script arguments without the `--` separator pnpm forwards as-is from `pnpm <script> -- …`. */
export function scriptArgs(argv: string[]): string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

/** Runs `main` when the module is the entry point; errors become `{ ok: false }` and exit 1. */
export function runMain(moduleUrl: string, main: (argv: string[]) => Promise<void>): void {
  if (!process.argv[1] || pathToFileURL(process.argv[1]).href !== moduleUrl) return;
  main(scriptArgs(process.argv.slice(2))).catch((error: unknown) => {
    const hint = error instanceof CliError ? error.hint : undefined;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}${hint ? `\n${hint}` : ''}\n`);
    printJson({ ok: false, error: message, ...(hint ? { hint } : {}) });
    process.exitCode = 1;
  });
}
