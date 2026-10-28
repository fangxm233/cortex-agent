// Test-only guard through gateway-manager's injection seams: the smoke daemon must use its own
// CORTEX_GATEWAY_PORT and never probe or spawn the user's live 9880 gateway. The pid marker proves
// that SEA re-applied NODE_OPTIONS preloads in the daemon and its forked app.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
const port = process.env.CORTEX_GATEWAY_PORT ?? '';
const home = process.env.CORTEX_HOME ?? '';
if (!path.isAbsolute(home) || !/^\d+$/.test(port) || Number(port) < 1024 || port === '9880') {
  throw new Error('SEA smoke preload requires an explicit isolated home and gateway port');
}
fs.appendFileSync(path.join(home, 'sea-smoke-preload.pids'), `${process.pid}\n`);
globalThis.__mockHttpGet = (url, ...args) => {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.port !== port) throw new Error(`Unexpected gateway probe: ${target}`);
  return http.get(target, ...args);
};
globalThis.__mockChildProcessSpawn = (command, args, options) => {
  if (!args[0].replaceAll('\\', '/').endsWith('/gateway-cli.js') || args.at(-2) !== '-p' || args.at(-1) !== port) {
    throw new Error('Unexpected gateway spawn');
  }
  return spawn(command, args, options);
};
