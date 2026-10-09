import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { CLIENT, SERVER, roleFor, identity, key } from './processes.mjs';
import { nodeIdentityCommand } from './product.mjs';

test('classifies exact product entries, including rotated client layouts', () => {
  assert.equal(roleFor(['node', CLIENT]), 'client');
  assert.equal(roleFor(['node', CLIENT.replace('/current/', '/previous/')]), 'client');
  assert.equal(roleFor(['node', `${SERVER}/dist/entry/app.js`]), 'app');
  assert.equal(roleFor(['node', `${SERVER}/dist/entry/daemon.js`]), 'daemon');
});

test('does not count CLI, commands, unrelated clients or path substrings', () => {
  for (const argv of [
    ['node', `${SERVER}/dist/entry/cortex-cli.js`, 'daemon'],
    ['bash', '-lc', `node ${CLIENT}`], ['node', '/other/client.mjs'], ['node', `${CLIENT}.bak`],
  ]) assert.equal(roleFor(argv), null);
});

test('node identity assertion survives Bash quoting without reading host profiles', () => {
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/unused-harness-home',
    CORTEX_HOME: '/unused-harness-home/.cortex', CORTEX_NPM_PREFIX: '/unused-prefix',
    npm_config_cache: '/unused-cache', CLAUDE_CONFIG_DIR: '/unused-claude' };
  const stdout = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', nodeIdentityCommand()],
    { env, encoding: 'utf8', timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), { node: process.execPath, version: process.version, env });
});

test('proc identity includes stat start time and tolerates exited processes', () => {
  const current = identity(process.pid);
  assert.equal(current.pid, process.pid);
  assert.match(current.start, /^\d+$/);
  assert.equal(key(current), `${process.pid}:${current.start}`);
  assert.equal(identity(2147483647), null);
});
