import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  groupKeyOf, redactMessage, redactStack, redactText, MAX_MESSAGE_CHARS, type RedactionContext,
} from '@domain/telemetry/redact.js';

const POSIX: RedactionContext = {
  installRoot: '/usr/lib/node_modules/@cortex-agent/server',
  homeDir: '/home/alice',
  username: 'alice',
  hostname: 'alice-workstation',
};
const WINDOWS: RedactionContext = {
  installRoot: 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@cortex-agent\\server',
  homeDir: 'C:\\Users\\Alice',
  username: 'Alice',
  hostname: 'DESKTOP-ABC123',
};

test('Cortex frames keep their install-relative path; other absolute paths are cut', () => {
  const stack = [
    'Error: ENOENT: no such file or directory, open \'/home/alice/.cortex/data/sessions.json\'',
    '    at readJson (/usr/lib/node_modules/@cortex-agent/server/dist/store/json.js:12:9)',
    '    at file:///usr/lib/node_modules/@cortex-agent/server/dist/entry/app.js:40:1',
    '    at Object.<anonymous> (/opt/tools/other/index.js:1:1)',
    '    at node:internal/process/task_queues:95:5',
  ].join('\n');
  const out = redactText(stack, POSIX);
  assert.match(out, /at readJson \(dist\/store\/json\.js:12:9\)/);
  assert.match(out, /at dist\/entry\/app\.js:40:1/);
  assert.match(out, /open '<path>'/);
  assert.match(out, /\(<path>:1:1\)/);
  assert.match(out, /node:internal\/process\/task_queues:95:5/);
  assert.doesNotMatch(out, /alice/i);
});

test('Windows install paths, user paths and UNC shares are handled', () => {
  const text = [
    'at x (C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@cortex-agent\\server\\dist\\core\\log.js:5:3)',
    "EPERM: operation not permitted, fsync 'C:\\Users\\Alice\\.cortex\\data\\a.json'",
    'share \\\\fileserver\\team\\notes.txt',
    'file:///C:/Users/Alice/AppData/Roaming/npm/node_modules/@cortex-agent/server/dist/entry/app.js:1:1',
  ].join('\n');
  const out = redactText(text, WINDOWS);
  assert.match(out, /dist\/core\/log\.js:5:3/);
  assert.match(out, /fsync '<path>'/);
  assert.match(out, /share <path>/);
  assert.match(out, /^dist\/entry\/app\.js:1:1$/m);
  assert.doesNotMatch(out, /Alice|fileserver/);
});

test('URLs keep scheme and path; host, query, fragment and credentials go', () => {
  const out = redactText('fetch https://user:pw@gw.private.example:8443/v1/chat?key=abc#frag failed', POSIX);
  assert.equal(out, 'fetch https://<host>/v1/chat failed');
  assert.equal(redactText('http://127.0.0.1:3004/trpc/x?y=1', POSIX), 'http://127.0.0.1:3004/trpc/x');
  assert.equal(redactText('cortexui://localhost/assets/index-a1.js:1:2', POSIX), 'cortexui://localhost/assets/index-a1.js:1:2');
});

test('emails, keys, long hex/base64 runs and IP addresses are masked', () => {
  const out = redactText([
    'user alice.smith@example.com',
    'key sk-ant-api03-abcdefghijklmnop',
    'token ghp_1234567890abcdefABCDEF',
    'sha 0123456789abcdef0123456789abcdef01234567',
    'b64 QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA',
    'from 10.18.1.2 via 127.0.0.1',
  ].join('\n'), POSIX);
  assert.doesNotMatch(out, /alice\.smith|sk-ant|ghp_|0123456789abcdef0123|QWxhZGRp|10\.18/);
  assert.match(out, /<email>/);
  assert.match(out, /<secret>/);
  assert.match(out, /from <ip> via 127\.0\.0\.1/);
});

test('identifiers and relative Cortex paths survive', () => {
  const text = 'TypeError: handleSessionsSubagentTranscript is not a function at dist/domain/ui-service/query/sessions.js';
  assert.equal(redactText(text, POSIX), text);
});

test('the user and host names are masked wherever they appear, as whole words', () => {
  const out = redactText('user alice on alice-workstation (malice ok)', POSIX);
  assert.equal(out, 'user <user> on <host> (malice ok)');
});

test('messages are capped; stacks keep at most 30 frames', () => {
  assert.equal(redactMessage('x'.repeat(1_000), POSIX).length, MAX_MESSAGE_CHARS);
  const stack = ['Error: deep', ...Array.from({ length: 50 }, (_, i) => `    at f${i} (dist/a.js:${i}:1)`)].join('\n');
  const lines = redactStack(stack, POSIX).split('\n');
  assert.equal(lines.length, 31);
  assert.equal(lines[0], 'Error: deep');
});

test('the group key is the error name and first Cortex frame, stable across line numbers', () => {
  const a = groupKeyOf('TypeError', 'TypeError: x\n    at <path>:1:1\n    at runTurn (dist/domain/runs/service.js:10:5)');
  const b = groupKeyOf('TypeError', 'TypeError: y\n    at runTurn (dist/domain/runs/service.js:99:7)');
  assert.equal(a, 'TypeError@dist/domain/runs/service.js#runTurn');
  assert.equal(a, b);
  assert.equal(groupKeyOf('Error', 'Error: z\n    at <path>:1:1'), 'Error@unknown');
  const web = groupKeyOf('TypeError', 'TypeError: q\n    at Ab (https://<host>/assets/index-B1x.js:1:2345)');
  assert.equal(web, 'TypeError@/assets/index-B1x.js');
});
