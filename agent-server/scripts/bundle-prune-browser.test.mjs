import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hostBinary, pruneBrowser } from './bundle-prune-browser.mjs';

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-musl-arm64', 'linux-musl-x64', 'win32-x64.exe'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'agent-browser', version: '0.39.1', bin: { 'agent-browser': './bin/agent-browser.js' } }));
  for (const name of [...platforms.map(p => `agent-browser-${p}`), 'agent-browser.js', '.install-method']) fs.writeFileSync(path.join(root, 'bin', name), 'fixture');
  return root;
}
for (const [platform, arch, musl, expected] of [
  ['darwin', 'arm64', false, 'darwin-arm64'], ['darwin', 'x64', false, 'darwin-x64'],
  ['linux', 'arm64', false, 'linux-arm64'], ['linux', 'x64', false, 'linux-x64'],
  ['linux', 'arm64', true, 'linux-musl-arm64'], ['linux', 'x64', true, 'linux-musl-x64'],
  ['win32', 'x64', false, 'win32-x64.exe'], ['win32', 'arm64', false, 'win32-x64.exe'],
]) {
  test(`keep launcher target ${platform}/${arch}/${musl}`, t => {
    const root = fixture(t);
    assert.equal(pruneBrowser(root, platform, arch, musl).length, 6);
    assert.deepEqual(fs.readdirSync(path.join(root, 'bin')).sort(), ['.install-method', `agent-browser-${expected}`, 'agent-browser.js'].sort());
    assert.deepEqual(pruneBrowser(root, platform, arch, musl), []);
  });
}
test('Windows native arm64 takes precedence when supplied', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'bin/agent-browser-win32-arm64.exe'), 'fixture');
  assert.equal(pruneBrowser(root, 'win32', 'arm64', false).length, 7);
  assert(fs.existsSync(path.join(root, 'bin/agent-browser-win32-arm64.exe')));
});
for (const [name, change] of [
  ['unknown layout', root => fs.writeFileSync(path.join(root, 'bin/new-file'), '')],
  ['missing host', root => fs.unlinkSync(path.join(root, 'bin/agent-browser-linux-x64'))],
  ['changed version', root => fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.40.0"}')],
  ['directory', root => fs.mkdirSync(path.join(root, 'bin/new-dir'))],
]) {
  test(`leave package intact: ${name}`, t => {
    const root = fixture(t); change(root);
    const before = fs.readdirSync(path.join(root, 'bin'));
    assert.deepEqual(pruneBrowser(root, 'linux', 'x64', false), []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'bin')), before);
  });
}
test('unsupported platform and architecture do not prune', t => {
  const root = fixture(t);
  assert.deepEqual(pruneBrowser(root, 'freebsd', 'x64', false), []);
  assert.deepEqual(pruneBrowser(root, 'linux', 'riscv64', false), []);
  assert.equal(hostBinary('linux', 'x86_64', true, () => true), 'agent-browser-linux-musl-x64');
});
