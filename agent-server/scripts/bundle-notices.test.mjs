import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { thirdPartyNotices } from './bundle-notices.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync('/tmp/cortex-notices-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function put(cwd, file, content) {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function pkg(cwd, root, metadata, files = { LICENSE: 'Complete fixture license.\n' }) {
  put(cwd, `${root}/package.json`, JSON.stringify(metadata));
  put(cwd, `${root}/index.js`, '');
  for (const [file, content] of Object.entries(files)) put(cwd, `${root}/${file}`, content);
  return `${root}/index.js`;
}
function notices(cwd, inputFiles = [], packageJsons = []) {
  return thirdPartyNotices({ cwd, inputFiles, packageJsons });
}

test('scope follows inputs, not the installed tree, and includes WASM', t => {
  const cwd = fixture(t);
  const used = pkg(cwd, 'node_modules/used', { name: 'used', version: '1', license: 'MIT' });
  pkg(cwd, 'node_modules/dev-only', { name: 'dev-only', version: '1' });
  const wasm = put(cwd, 'node_modules/used/quickjs.wasm', 'wasm fixture');
  pkg(cwd, 'workspace', { name: '@cortex-agent/server', version: '1' });
  const result = notices(cwd, [used, wasm, 'workspace/index.js', '<stdin>']);
  assert.match(result, /Package: used@1/);
  assert.equal(result.split('Package: used@1').length, 2);
  assert.doesNotMatch(result, /dev-only|@cortex-agent\/server/);
});

test('deduplicates identities but preserves distinct versions and differing notice texts', t => {
  const cwd = fixture(t);
  const one = pkg(cwd, 'node_modules/one', { name: 'shared', version: '1', license: 'MIT' });
  const copy = pkg(cwd, 'nested/node_modules/one', { name: 'shared', version: '1', license: 'MIT' }, { LICENSE: 'Other complete license.\n' });
  const two = pkg(cwd, 'node_modules/two', { name: 'shared', version: '2', license: 'ISC' });
  const result = notices(cwd, [one, copy, two, one]);
  assert.equal(result.split('Package: shared@1').length, 2);
  assert.match(result, /Package: shared@2/);
  assert.match(result, /Complete fixture license\.\n/);
  assert.match(result, /Other complete license\.\n/);
  assert.equal(result, notices(cwd, [two, copy, one]));
});

test('retains full legal files and nested license directories without scanning source trees', t => {
  const cwd = fixture(t);
  const full = 'Copyright fixture authors\n\nPermission in full.\n\nFinal restriction.\n';
  const input = pkg(cwd, 'node_modules/@vendor/lib', { name: '@vendor/lib', version: '3', license: '(MIT OR Apache-2.0)' }, {
    'LICENSE.md': full, 'LICENCE': 'British spelling\n', 'NOTICE.txt': 'Full notice\n',
    'COPYING': 'Copying terms\n', 'licenses/vendor/terms.txt': 'Nested terms\n',
    'src/not-legal.txt': 'DO NOT INCLUDE', 'licenses/node_modules/hidden/LICENSE': 'DO NOT INCLUDE',
  });
  put(cwd, 'node_modules/@vendor/lib/dist/package.json', '{"type":"module"}');
  const result = notices(cwd, [input, 'node_modules/@vendor/lib/dist/index.js']);
  for (const text of [full, 'British spelling\n', 'Full notice\n', 'Copying terms\n', 'Nested terms\n']) assert(result.includes(text));
  assert.match(result, /Declared license: \(MIT OR Apache-2\.0\)/);
  assert.doesNotMatch(result, /DO NOT INCLUDE|UNKNOWN/);
});

test('reports absent metadata and license files without inventing attribution', t => {
  const cwd = fixture(t);
  const input = pkg(cwd, 'node_modules/mystery', {}, { README: '# Example\n\n## License\n\nUse under the ISC license.\n' });
  const result = notices(cwd, [input]);
  assert.match(result, /Package: mystery@UNKNOWN/);
  assert.match(result, /Missing metadata: name, version, license/);
  assert.match(result, /WARNING: No LICENSE\/LICENCE\/COPYING file found/);
  assert.match(result, /Use under the ISC license\./);
  assert.doesNotMatch(result, /Copyright/);
});

test('keeps declared legacy license metadata and README fallback alongside NOTICE', t => {
  const cwd = fixture(t);
  const licenses = [{ type: 'MIT', url: 'https://example.test/license' }];
  const input = pkg(cwd, 'node_modules/legacy', { name: 'legacy', version: '1', licenses }, {
    NOTICE: 'Attribution only\n', 'README.md': '# Usage\n\nUnrelated usage.\n\n# License\n\nCopyright fixture.\nMIT terms.\n\n# API\n\nUnrelated API.',
  });
  const result = notices(cwd, [input]);
  assert(result.includes(JSON.stringify(licenses)));
  assert.match(result, /Copyright fixture\.\nMIT terms\./);
  assert.match(result, /Attribution only/);
  assert.doesNotMatch(result, /Unrelated usage|Unrelated API/);
});

test('preserves complete setext README license sections, including paragraphs without license keywords', t => {
  const cwd = fixture(t);
  const terms = 'License\n-------\n\nMIT\n\nCopyright fixture authors.\n\nAll terms must be retained.\n\nTHE SOFTWARE IS PROVIDED AS IS.\n';
  const input = pkg(cwd, 'node_modules/readme-only', { name: 'readme-only', version: '1', license: 'MIT' }, {
    'README.md': `Usage\n=====\n\nUnrelated usage.\n\n${terms}\nAPI\n---\n\nUnrelated API.`,
  });
  const result = notices(cwd, [input]);
  assert(result.includes(terms));
  assert.doesNotMatch(result, /Unrelated usage|Unrelated API/);
});

test('walks production dependencies, installed optional dependencies and peers, excluding dev and workspaces', t => {
  const cwd = fixture(t);
  pkg(cwd, 'web', { dependencies: { direct: '*', '@cortex-agent/ui-contract': 'workspace:*' }, devDependencies: { dev: '*' } });
  pkg(cwd, 'node_modules/direct', { name: 'direct', version: '1', dependencies: { child: '*' }, optionalDependencies: { optional: '*', absent: '*' }, peerDependencies: { peer: '*' }, devDependencies: { dev: '*' } });
  for (const name of ['child', 'optional', 'peer', 'dev']) pkg(cwd, `node_modules/${name}`, { name, version: '1', license: 'MIT' });
  pkg(cwd, 'node_modules/@cortex-agent/ui-contract', { name: '@cortex-agent/ui-contract', dependencies: { dev: '*' } });
  const result = notices(cwd, [], ['web/package.json']);
  for (const name of ['direct', 'child', 'optional', 'peer']) assert(result.includes(`Package: ${name}@1`));
  assert.doesNotMatch(result, /Package: dev@|Package: @cortex-agent\/|absent/);
});

test('resolves nested, hoisted, alias and exports-restricted packages with dependency cycles', t => {
  const cwd = fixture(t);
  pkg(cwd, 'client', { dependencies: { outer: '*', alias: 'npm:actual@1' } });
  pkg(cwd, 'node_modules/outer', { name: 'outer', version: '1', dependencies: { child: '*' } });
  pkg(cwd, 'node_modules/outer/node_modules/child', { name: 'child', version: '2', dependencies: { outer: '*' }, exports: './index.js' });
  pkg(cwd, 'node_modules/child', { name: 'child', version: 'WRONG' });
  pkg(cwd, 'node_modules/alias', { name: 'actual', version: '1', exports: './index.js' });
  const result = notices(cwd, [], [path.join(cwd, 'client/package.json')]);
  assert.match(result, /Package: child@2/);
  assert.match(result, /Package: actual@1/);
  assert.equal(result.split('Package: outer@1').length, 2);
  assert.doesNotMatch(result, /WRONG/);
});

test('resolves pnpm symlink dependencies from their physical package roots', t => {
  const cwd = fixture(t);
  pkg(cwd, 'web', { dependencies: { linked: '*' } });
  const root = 'node_modules/.pnpm/linked@1/node_modules/linked';
  const input = pkg(cwd, root, { name: 'linked', version: '1', dependencies: { child: '*' } });
  pkg(cwd, 'node_modules/.pnpm/linked@1/node_modules/child', { name: 'child', version: '1' });
  fs.symlinkSync(path.join(cwd, root), path.join(cwd, 'node_modules/linked'), 'dir');
  const result = notices(cwd, [input, 'node_modules/linked/index.js'], ['web/package.json']);
  assert.equal(result.split('Package: linked@1').length, 2);
  assert.match(result, /Package: child@1/);
});

test('does not traverse the runtime dependency tree of input-only packages', t => {
  const cwd = fixture(t);
  const input = pkg(cwd, 'node_modules/selected', { name: 'selected', version: '1', dependencies: { unused: '*' } });
  pkg(cwd, 'node_modules/unused', { name: 'unused', version: '1' });
  assert.doesNotMatch(notices(cwd, [input]), /Package: unused@/);
});

test('reports missing required dependencies but skips missing optional overrides and peers', t => {
  const cwd = fixture(t);
  pkg(cwd, 'web', { name: '@cortex-agent/web', dependencies: { missing: '*', optional: '*' }, optionalDependencies: { optional: '*' }, peerDependencies: { peer: '*' } });
  const result = notices(cwd, [], ['web/package.json']);
  assert.match(result, /WARNING: Unresolved production dependency: @cortex-agent\/web -> missing/);
  assert.doesNotMatch(result, /-> optional|-> peer/);
});

test('handles an input package with no manifest and rejects malformed supplied manifests', t => {
  const cwd = fixture(t);
  const input = put(cwd, 'node_modules/no-manifest/index.js', '');
  assert.match(notices(cwd, [input]), /Package: no-manifest@UNKNOWN/);
  put(cwd, 'web/package.json', '{bad json');
  assert.throws(() => notices(cwd, [], ['web/package.json']), SyntaxError);
  assert.throws(() => notices(cwd, [], ['missing/package.json']), /ENOENT/);
});

test('license-directory symlink loops and links outside the package are not followed', t => {
  const cwd = fixture(t);
  const input = pkg(cwd, 'node_modules/safe', { name: 'safe', version: '1' }, { 'licenses/MIT.txt': 'Safe text\n' });
  put(cwd, 'private/secret', 'DO NOT INCLUDE');
  fs.symlinkSync(path.join(cwd, 'private'), path.join(cwd, 'node_modules/safe/licenses/outside'), 'dir');
  fs.symlinkSync(path.join(cwd, 'node_modules/safe/licenses'), path.join(cwd, 'node_modules/safe/licenses/loop'), 'dir');
  const result = notices(cwd, [input]);
  assert.match(result, /Safe text/);
  assert.doesNotMatch(result, /DO NOT INCLUDE/);
});
