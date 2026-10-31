// TEST ONLY. Loaded in every Node subprocess via the harness's sanitized NODE_OPTIONS.
// Networking guards and boot evidence only; application source is never rewritten.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installGuards } from './bundle-daemon-guards.mjs';

const root = process.env.CORTEX_BUNDLE_TESTROOT;
assert(root && /^\/tmp\/cortex-bundle-[^/]+$/.test(root), 'Preload requires a /tmp/cortex-bundle-* root');
assert.equal(fs.realpathSync(root), root, 'Symlink test root is forbidden');
for (const key of ['HOME', 'CORTEX_AISTATUS_HOME', 'CORTEX_HOME', 'CORTEX_NPM_PREFIX', 'npm_config_prefix', 'CORTEX_BUNDLE_EVENTS']) {
  assert(process.env[key]?.startsWith(root + '/'), `Preload refuses nonisolated ${key}`);
}
const eventFile = process.env.CORTEX_BUNDLE_EVENTS;
// CORTEX_UI_PORT may be unset: the home's .env then names a port from the search range below.
const ports = process.env.CORTEX_UI_PORT ? [Number(process.env.CORTEX_UI_PORT)] : [];
assert(ports.every(port => Number.isInteger(port) && port > 1023 && port !== 9880));

function record(type, detail = {}) {
  fs.appendFileSync(eventFile, JSON.stringify({ type, pid: process.pid, ppid: process.ppid,
    monotonicNs: process.hrtime.bigint().toString(), at: new Date().toISOString(), ...detail }) + '\n');
}

function observeBoot(stream) {
  const original = stream.write;
  stream.write = function (chunk, ...args) {
    const match = String(chunk).match(/boot (\d+)ms \(imports (\d+)ms\)/);
    if (match) record('app-ready', { bootMs: Number(match[1]), importsMs: Number(match[2]) });
    return Reflect.apply(original, this, [chunk, ...args]);
  };
}

// `cortex init` probes the main-port search range (26789-26999) for a free port to record.
const mainPortSearch = Array.from({ length: 211 }, (_, i) => 26789 + i);
installGuards(record, [...ports, ...mainPortSearch]);
record('process-start', { argv: process.argv, execArgv: process.execArgv, sourceMaps: process.sourceMapsEnabled,
  aistatusHome: process.env.CORTEX_AISTATUS_HOME,
  cwd: process.cwd(), home: process.env.HOME, cortexHome: process.env.CORTEX_HOME, npmPrefix: process.env.npm_config_prefix,
  identity: fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] });
observeBoot(process.stdout);
observeBoot(process.stderr);
process.on('uncaughtExceptionMonitor', error => record('uncaught', { stack: error.stack }));
