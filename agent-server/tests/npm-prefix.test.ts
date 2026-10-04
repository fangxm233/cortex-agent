import { test } from 'vitest';
import assert from 'node:assert/strict';

import { npmPrefixFromInstallRoot, withServerNpmPrefix } from '../src/core/utils.js';

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
