#!/usr/bin/env node
//
// `pnpm run build`: typecheck, boundary check and bundle, run concurrently.
//
// vite build does not typecheck, so the three share no inputs and running them in sequence only
// adds their times together. Every exit code counts: the step fails when any job fails, so a type
// error or a boundary violation cannot slip through the daemon's rebuild pipeline. A failed check
// can leave a bundle in dist/, but the non-zero exit aborts the pipeline before it is installed.
//
// A Node script rather than shell `&`/`wait`, because pnpm runs package scripts through cmd.exe on
// Windows, where that syntax does not exist.

import { spawn } from 'node:child_process';

const JOBS = ['tsc --noEmit', 'pnpm run depcruise', 'vite build'];

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
