// Stand-ins for Chrome and Xvfb, so the managed-browser lifecycle can be driven end to end without
// touching a real browser or display. Both are tiny node scripts that record what they were asked
// to do (pid, DISPLAY, display number) under FAKE_BROWSER_LOG; behaviour is steered by env vars the
// launcher passes through untouched.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FAKE_CHROME = `
const fs = require('fs'), http = require('http'), path = require('path');
const log = process.env.FAKE_BROWSER_LOG;
const display = process.env.DISPLAY || null;
fs.writeFileSync(path.join(log, 'chrome-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, display, at: String(process.hrtime.bigint()) }));
const mode = process.env.FAKE_CHROME_MODE || 'serve';
if (mode === 'exit') process.exit(1);
// Like real Chrome: with no X server behind DISPLAY, it dies at startup.
if (mode === 'require-display' && !fs.existsSync(path.join(log, 'xvfb-ready-' + String(display).slice(1)))) process.exit(1);
const portArg = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
const port = Number(portArg.split('=')[1]);
setTimeout(() => {
  http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); })
    .listen(port, '127.0.0.1');
}, Number(process.env.FAKE_CHROME_DELAY_MS || 0));
`;

const FAKE_XVFB = `
const fs = require('fs'), path = require('path');
const log = process.env.FAKE_BROWSER_LOG;
const display = process.argv[2];
const fdIdx = process.argv.indexOf('-displayfd');
fs.writeFileSync(path.join(log, 'xvfb-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, display, at: String(process.hrtime.bigint()) }));
setTimeout(() => {
  fs.writeFileSync(path.join(log, 'xvfb-ready-' + display.slice(1)), '');
  if (fdIdx > 0) fs.writeSync(Number(process.argv[fdIdx + 1]), display.slice(1) + '\\n');
}, Number(process.env.FAKE_XVFB_DELAY_MS || 0));
setInterval(() => {}, 1000);
`;

export interface FakeBrowserKit {
  chrome: string;
  binDir: string;
  logDir: string;
  /** Records the fakes left behind, read fresh each call, oldest first. */
  spawned(kind: 'chrome' | 'xvfb'): Array<{ pid: number; display: string | null }>;
  /** Kill anything still running — a failing test must not leave fakes behind. */
  cleanup(): void;
}

export function makeFakeBrowserKit(): FakeBrowserKit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-browser-'));
  const binDir = path.join(root, 'bin');
  const logDir = path.join(root, 'log');
  fs.mkdirSync(binDir);
  fs.mkdirSync(logDir);
  const write = (name: string, body: string) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
    return file;
  };
  const chrome = write('fake-chrome', FAKE_CHROME);
  write('Xvfb', FAKE_XVFB);

  // Ordered by the monotonic clock each fake stamped at startup. readdir returns names sorted as
  // strings, and pid order is not spawn order once pids roll over a digit (99999 → 100000) or wrap.
  const spawned = (kind: 'chrome' | 'xvfb') =>
    fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')))
      .sort((a, b) => (BigInt(a.at) < BigInt(b.at) ? -1 : 1));

  return {
    chrome,
    binDir,
    logDir,
    spawned,
    cleanup() {
      for (const { pid } of [...spawned('chrome'), ...spawned('xvfb')]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
