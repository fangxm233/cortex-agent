import fs from 'node:fs';
import assert from 'node:assert/strict';

export const HOME = '/home/tester';
export const CORTEX = `${HOME}/.cortex`;
export const EVIDENCE = `${HOME}/.harness`;
export const SERVER = '/inputs/server';
export const CLIENT = `${CORTEX}/client/current/client.mjs`;

export function roleFor(argv) {
  if (argv.some(a => /^\/home\/tester\/\.cortex\/client\/[^/]+\/client\.mjs$/.test(a))) return 'client';
  if (argv.includes(`${SERVER}/dist/entry/app.js`)) return 'app';
  if (argv.includes(`${SERVER}/dist/entry/daemon.js`)) return 'daemon';
  return null;
}

export function identity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(/\) /).at(-1).split(' ');
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (fields[0] === 'Z') return null;
    return { pid: Number(pid), start: fields[19], role: roleFor(argv) };
  } catch { return null; }
}

export function inventory() {
  return fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))
    .map(identity).filter(p => p?.role);
}

export function key(item) { return `${item.pid}:${item.start}`; }

export function births(role) {
  const dir = `${EVIDENCE}/starts`;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.startsWith(`${role}-`))
    .map(n => JSON.parse(fs.readFileSync(`${dir}/${n}`, 'utf8')));
}

export function assertBirthSummary(records, expected, leaders, lookup = identity) {
  for (const role of ['daemon', 'app', 'client']) assert.equal(records[role].length, expected[role]);
  for (const contender of records.daemon.filter(p => !leaders.has(key(p)))) {
    assert.notEqual(lookup(contender.pid)?.start, contender.start, 'Daemon contender must have exited');
  }
}

export function monitor() {
  const seen = new Map();
  let maximumClients = 0;
  const sample = () => {
    const entries = inventory();
    maximumClients = Math.max(maximumClients, entries.filter(p => p.role === 'client').length);
    for (const entry of entries) seen.set(key(entry), entry);
  };
  sample();
  const timer = setInterval(sample, 10);
  return { stop() { clearInterval(timer); sample(); return { maximumClients, seen: [...seen.values()] }; } };
}
