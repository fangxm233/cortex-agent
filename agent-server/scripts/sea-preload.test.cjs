const { test } = require('node:test');
const assert = require('node:assert/strict');
const { envArgs, preloads, loadPreloads } = require('./sea-preload.cjs');

test('NODE_OPTIONS uses Node double-quote and escape rules, not shell quoting', () => {
  assert.deepEqual(envArgs(' --import="file:///tmp/a b.mjs" --require ./c.cjs '), ['--import=file:///tmp/a b.mjs', '--require', './c.cjs']);
  assert.deepEqual(envArgs('a"b c"d "a\\"b" a\\b ""'), ['ab cd', 'a"b', 'a\\b']);
  assert.deepEqual(envArgs("'a b' x\ty"), ["'a", "b'", 'x\ty']);
});

test('extract only imports and requires, with either flag syntax', () => {
  assert.deepEqual(preloads(['--no-warnings', '--import=a', '--require', 'b', '-r', 'c', '--import', 'd']), {
    require: ['b', 'c'], import: ['a', 'd'],
  });
});

test('execute data URL preload before the entry point', async () => {
  await loadPreloads('--import=data:text/javascript,globalThis.__seaPreload=42');
  assert.equal(globalThis.__seaPreload, 42);
  delete globalThis.__seaPreload;
});
