// Test-only preload. Never authenticates, starts a client, or sends a WS frame.
// Hooks only the packed app's real ws server, after its verifyClient gate.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { EVIDENCE, SERVER, identity, roleFor } from './processes.mjs';

function recordStart() {
  const current = identity(process.pid);
  if (!current?.role) return;
  fs.mkdirSync(`${EVIDENCE}/starts`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${EVIDENCE}/starts/${current.role}-${current.pid}-${current.start}.json`,
    JSON.stringify(current), { mode: 0o600 });
}

function recordHello(raw) {
  try {
    const frame = JSON.parse(raw.toString());
    if (frame.type !== 'hello' || frame.device !== 'test-local') return;
    const hash = /^[a-f0-9]{64}$/.test(frame.bundleHash) ? frame.bundleHash : null;
    fs.appendFileSync(`${EVIDENCE}/hello.jsonl`, JSON.stringify({
      appPid: process.pid, device: 'test-local', hash, at: Date.now(),
    }) + '\n', { mode: 0o600 });
  } catch { /* Never serialize frame content or authentication material. */ }
}

function observeServer() {
  const { WebSocketServer } = createRequire(`${SERVER}/package.json`)('ws');
  const original = WebSocketServer.prototype.emit;
  WebSocketServer.prototype.emit = function (event, ...args) {
    if (event === 'connection') args[0].on('message', recordHello);
    return Reflect.apply(original, this, [event, ...args]);
  };
}

recordStart();
if (roleFor(process.argv) === 'app') observeServer();
