// Test-only port remapping through gateway-manager's existing injection seams.
// Production fixes its gateway port at 9880; never adopt the user's live gateway in a smoke run.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
const port = Number(process.env.CORTEX_BUNDLE_SMOKE_GATEWAY_PORT);
if (!isAbsolute(process.env.CORTEX_HOME ?? '') || !Number.isInteger(port) || port < 1024 || port === 9880) {
  throw new Error('Bundle smoke preload requires an explicit isolated home and gateway port');
}
globalThis.__mockHttpGet = (url, ...args) => {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1' || target.port !== '9880') throw new Error(`Unexpected gateway probe: ${target}`);
  target.port = String(port);
  return http.get(target, ...args);
};
globalThis.__mockChildProcessSpawn = (command, args, options) => {
  if (!args[0].endsWith('/gateway-cli.js') || args.at(-2) !== '-p' || args.at(-1) !== '9880') {
    throw new Error('Unexpected gateway spawn');
  }
  return spawn(command, [...args.slice(0, -1), String(port)], options);
};
