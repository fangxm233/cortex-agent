import { test } from 'vitest';
import assert from 'node:assert/strict';

import { npmInvocation, npmPrefixFromInstallRoot, withServerNpmPrefix } from '../src/core/utils.js';

const PKG = '@cortex-agent/server';

test('npmPrefixFromInstallRoot - posix global layout', () => {
  assert.equal(npmPrefixFromInstallRoot('/opt/node22/lib/node_modules/@cortex-agent/server', PKG, 'linux'), '/opt/node22');
  assert.equal(npmPrefixFromInstallRoot('/home/u/.npm-global/lib/node_modules/@cortex-agent/server', PKG, 'darwin'), '/home/u/.npm-global');
});

test('npmPrefixFromInstallRoot - windows global layout', () => {
  assert.equal(
    npmPrefixFromInstallRoot('D:\\tools\\npm\\node_modules\\@cortex-agent\\server', PKG, 'win32'),
    'D:\\tools\\npm',
  );
});

test('npmPrefixFromInstallRoot - non-global locations yield null', () => {
  assert.equal(npmPrefixFromInstallRoot('/home/u/Cortex/agent-server', PKG, 'linux'), null);
  assert.equal(npmPrefixFromInstallRoot('/srv/app/node_modules/@cortex-agent/server', PKG, 'linux'), null);
  assert.equal(npmPrefixFromInstallRoot('/x/lib/node_modules/other/server', PKG, 'linux'), null);
});

test('withServerNpmPrefix - override wins, then install root', () => {
  const prev = process.env.CORTEX_NPM_PREFIX;
  try {
    process.env.CORTEX_NPM_PREFIX = '/custom';
    assert.deepEqual(withServerNpmPrefix(['install', '-g', 'x'], '/a/lib/node_modules/@cortex-agent/server'),
      ['install', '-g', 'x', '--prefix', '/custom']);
    delete process.env.CORTEX_NPM_PREFIX;
    assert.deepEqual(withServerNpmPrefix(['install', '-g', 'x'], '/a/lib/node_modules/@cortex-agent/server'),
      ['install', '-g', 'x', '--prefix', '/a']);
  } finally {
    if (prev === undefined) delete process.env.CORTEX_NPM_PREFIX;
    else process.env.CORTEX_NPM_PREFIX = prev;
  }
});


test('npmInvocation keeps npm on Unix', () => {
  assert.deepEqual(npmInvocation(['view', 'pkg'], 'linux'), {
    command: 'npm', args: ['view', 'pkg'], shell: false,
  });
});

test('npmInvocation uses bundled npm CLI with node on Windows', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(npmInvocation(['view', 'pkg'], 'win32', node, (file) => file === cli), {
    command: node, args: [cli, 'view', 'pkg'], shell: false,
  });
});

test('npmInvocation falls back to the Windows command shim through a shell', () => {
  assert.deepEqual(npmInvocation(['view', 'pkg'], 'win32', 'C:\\node.exe', () => false), {
    command: 'npm.cmd', args: ['"view"', '"pkg"'], shell: true,
  });
});


test('npmInvocation quotes a Windows fallback prefix containing spaces and shell punctuation', () => {
  const prefix = 'C:\\Users\\Jane Doe\\Cortex & Tools';
  const invocation = npmInvocation(['install', '-g', 'pkg', '--prefix', prefix], 'win32', 'C:\\node.exe', () => false);
  assert.equal(invocation.shell, true);
  assert.equal(invocation.args.join(' '), `"install" "-g" "pkg" "--prefix" "${prefix}"`);
});


test('npmInvocation preserves a trailing backslash inside a quoted Windows prefix', () => {
  const prefix = 'C:\\Jane Doe\\';
  const invocation = npmInvocation(['--prefix', prefix], 'win32', 'C:\\node.exe', () => false);
  assert.equal(invocation.args[1], '"C:\\Jane Doe\\\\"');
});
