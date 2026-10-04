#!/usr/bin/env node
//
// `pnpm run build`: the typecheck, depcruise (boundary check) and bundle scripts, run concurrently.
//
// vite build does not typecheck, so the three share no inputs and running them in sequence only
// adds their times together. Every exit code counts: the build fails when any job fails, so a type
// error or a boundary violation cannot pass as a good build. A failed check can leave a bundle in
// dist/ — whatever consumes it has to honour the exit code.
//
// The daemon's hot-rebuild pipeline runs the same three scripts as separate steps instead of this
// one, so it can start the bundle before the server types the typecheck reads have been rebuilt.
//
// A Node script rather than shell `&`/`wait`, because pnpm runs package scripts through cmd.exe on
// Windows, where that syntax does not exist.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The script bodies, not `pnpm run <name>`: this already runs under a package script, so
// node_modules/.bin is on PATH, and a nested runner would add its startup to every build.
const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const JOBS = ['typecheck', 'depcruise', 'bundle'].map((name) => scripts[name]);

const codes = await Promise.all(
  JOBS.map((command) => new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('error', (err) => { console.error(`${command}: ${err.message}`); resolve(1); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  })),
);

const failed = JOBS.filter((_, i) => codes[i] !== 0);
if (failed.length) console.error(`build failed: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);
