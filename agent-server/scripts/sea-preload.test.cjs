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

test('imports use ESM builtin, URL and conditional-export resolution from cwd', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const previous = process.cwd(), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-preload-test-'));
  t.after(() => { process.chdir(previous); fs.rmSync(cwd, { recursive: true, force: true }); });
  const pkg = path.join(cwd, 'node_modules/probe'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ exports: { import: './yes.mjs', require: './no.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'yes.mjs'), 'globalThis.seaConditional = true;');
  fs.writeFileSync(path.join(pkg, 'no.cjs'), 'throw new Error("wrong require condition");');
  fs.writeFileSync(path.join(cwd, 'query.mjs'), 'globalThis.seaQuery = import.meta.url;');
  process.chdir(cwd);
  await loadPreloads('--import=fs --import=./query.mjs?one --import=probe');
  assert.equal(globalThis.seaConditional, true);
  assert(globalThis.seaQuery.endsWith('?one'));
  delete globalThis.seaConditional; delete globalThis.seaQuery;
});
