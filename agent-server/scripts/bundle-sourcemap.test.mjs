import assert from 'node:assert/strict';
import { SourceMap } from 'node:module';
import { test } from 'node:test';
import { insertBanner, prepareOutputs, SourceRewriter } from './bundle-sourcemap.mjs';

const banner = 'const one = 1;\nconst two = 2;\nconst three = 3;\n';
function map(mappings) {
  return { version: 3, sources: ['input.js'], sourcesContent: ['throw Error();\n'], names: [], mappings };
}

test('banner leaves three unmapped lines before ordinary output', () => {
  const original = map('AAAA;AACA');
  const result = insertBanner('throw Error();\n', banner, original);
  assert.equal(result.text, banner + 'throw Error();\n');
  assert.equal(result.map.mappings, ';;;AAAA;AACA');
  assert.equal(original.mappings, 'AAAA;AACA');
  assert.equal(new SourceMap(result.map).findEntry(3, 0).originalLine, 0);
});

test('banner follows the shebang and shifts only subsequent mapping lines', () => {
  const result = insertBanner('#!/usr/bin/env node\nthrow Error();\n', banner, map(';AAAA'));
  assert.equal(result.text, '#!/usr/bin/env node\n' + banner + 'throw Error();\n');
  assert.equal(result.map.mappings, ';;;;AAAA');
  assert.equal(new SourceMap(result.map).findEntry(4, 0).originalLine, 0);
});

test('release output remains identical without a map', () => {
  assert.deepEqual(insertBanner('run();\n', banner), { text: banner + 'run();\n', map: undefined });
});

function inlineMap(source) {
  const encoded = source.match(/base64,([^\n]+)/)[1];
  return JSON.parse(Buffer.from(encoded, 'base64').toString());
}

test('rewrites map inserted lines and changed columns back to prebundle JS', () => {
  const original = 'const url = import.meta.url; throw Error("first");\nthrow Error("second");\n';
  const source = new SourceRewriter(original, true);
  source.replaceAll('import.meta.url', 'new URL("longer", root).href');
  source.prepend('import { URL } from "node:url";\n');
  const mapping = inlineMap(source.contents('/fixture/input.js'));
  const lookup = new SourceMap(mapping);
  const column = source.text.split('\n')[1].indexOf('Error');
  assert.equal(lookup.findEntry(1, column).originalColumn, original.indexOf('Error'));
  assert.equal(lookup.findEntry(1, column).originalLine, 0);
  assert.equal(lookup.findEntry(2, 6).originalLine, 1);
  assert.equal(lookup.findEntry(2, 6).originalColumn, 6);
  assert.deepEqual(mapping.sourcesContent, [original]);
});

test('sourceMappingURL text is preserved even inside a template literal', () => {
  const original = 'const text = `\n//# sourceMappingURL=fake.map\n`;\n';
  const source = new SourceRewriter(original, true);
  const result = source.contents('/fixture/input.js');
  assert(result.startsWith(original));
  assert.deepEqual(inlineMap(result).sourcesContent, [original]);
});

test('map-only outputs are relocated without inserting a worker banner', () => {
  const outputs = prepareOutputs([
    { path: '/fixture/stage/worker.js', text: 'throw Error();\n//# sourceMappingURL=worker.js.map\n' },
    { path: '/fixture/stage/worker.js.map', text: JSON.stringify(map('AAAA')) },
  ]);
  assert.equal(outputs[0].text, 'throw Error();\n//# sourceMappingURL=worker.js.map\n');
  assert.deepEqual(JSON.parse(outputs[1].text).sources, ['file:///fixture/stage/input.js']);
  assert.equal(JSON.parse(outputs[1].text).mappings, 'AAAA');
});

test('multiple edits retain UTF-16 columns and CRLF line positions', () => {
  const original = 'const a = "😀"; old(); old(); throw Error();\r\nthrow Error();\r\n';
  const source = new SourceRewriter(original, true);
  source.replaceAll('old()', 'longerCall()').replace('longerCall()', 'short()');
  const lookup = new SourceMap(inlineMap(source.contents('/fixture/input.js')));
  assert.equal(lookup.findEntry(0, source.text.indexOf('Error')).originalColumn, original.indexOf('Error'));
  assert.equal(lookup.findEntry(1, 6).originalLine, 1);
  assert.equal(lookup.findEntry(1, 6).originalColumn, 6);
});

test('regex replacements retain capture semantics and subsequent original columns', () => {
  const source = new SourceRewriter('load("./a.ts"); throw Error();', true);
  source.replace(/load\("\.\/([\w-]+)\.ts"\)/g, (_match, name) => `import("./${name}.js")`);
  assert.equal(source.text, 'import("./a.js"); throw Error();');
  const lookup = new SourceMap(inlineMap(source.contents('/fixture/input.js')));
  assert.equal(lookup.findEntry(0, source.text.indexOf('Error')).originalColumn, 22);
});
