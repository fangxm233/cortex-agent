// input:  onboarding HTML bootstrap, node VM, storage fixtures
// output: Shared glass preference bootstrap regression tests
// pos:    Browser-independent first-paint appearance checks
// >>> Once updated, update this header and the parent AGENTS.md <<<
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

function bootstrap(page, glass, blocked = false) {
  const html = readFileSync(join(__dirname, '../ui', page), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const attributes = {};
  const document = {
    documentElement: {
      setAttribute: (key, value) => { attributes[key] = value; },
      style: { setProperty() {} }, classList: { add() {} },
    },
    querySelector: () => null,
  };
  const window = {
    localStorage: { getItem(key) {
      if (blocked) throw new Error('storage blocked');
      return key === 'cortex.glass' ? glass : null;
    } },
    matchMedia: () => ({ matches: false }),
  };
  runInNewContext(source, { window, document });
  return attributes;
}

for (const page of ['connect.html', 'setup.html']) {
  test(`${page} reads all saved glass levels before first paint`, () => {
    for (const glass of ['strong', 'medium', 'subtle', 'off']) {
      assert.equal(bootstrap(page, glass)['data-glass'], glass);
    }
  });
  test(`${page} leaves the theme default intact for absent or invalid storage`, () => {
    for (const value of [null, '', 'invalid', 'OFF']) {
      assert.equal(bootstrap(page, value)['data-glass'], undefined);
    }
    assert.equal(bootstrap(page, 'off', true)['data-glass'], undefined);
  });
}

test('both pages share the exact appearance bootstrap', () => {
  const scripts = ['connect.html', 'setup.html'].map(page =>
    readFileSync(join(__dirname, '../ui', page), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.equal(scripts[0], scripts[1]);
});
