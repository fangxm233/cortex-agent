// input:  Node test runner + template-resolver + tmp fs
// output: template frontmatter/vars/blocks/conditional tests
// pos:    Verify prompt template parsing flow
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { resolveTemplate } from '../src/domain/threads/template-resolver.js';

const TMP_DIR = join(import.meta.dirname!, '..', 'tmp', 'test-templates');

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- No template (passthrough) ---

test('plain content without frontmatter passes through unchanged', () => {
  const content = 'Hello world\nLine 2';
  assert.equal(resolveTemplate(content, TMP_DIR), content);
});

test('frontmatter without extends strips frontmatter and returns body', () => {
  const content = '---\nfoo: bar\n---\nBody content';
  assert.equal(resolveTemplate(content, TMP_DIR), 'Body content');
});

// --- Variable substitution ---

test('${var} replaced with frontmatter value', () => {
  writeFileSync(join(TMP_DIR, 'vars.md'), 'Hello ${name}, you are ${role}.');
  const consumer = '---\nextends: vars.md\nname: Alice\nrole: admin\n---\n';
  assert.equal(resolveTemplate(consumer, TMP_DIR), 'Hello Alice, you are admin.');
});

test('${var:-default} uses default when var is missing', () => {
  writeFileSync(join(TMP_DIR, 'defaults.md'), 'Hello ${name:-World}, cutoff ${date:-May 2025}.');
  const consumer = '---\nextends: defaults.md\nname: Bob\n---\n';
  assert.equal(resolveTemplate(consumer, TMP_DIR), 'Hello Bob, cutoff May 2025.');
});

test('undefined var without default becomes empty string', () => {
  writeFileSync(join(TMP_DIR, 'empty.md'), 'A${missing}B');
  const consumer = '---\nextends: empty.md\n---\n';
  assert.equal(resolveTemplate(consumer, TMP_DIR), 'AB');
});

test('quoted frontmatter values have quotes stripped', () => {
  writeFileSync(join(TMP_DIR, 'quoted.md'), '${msg}');
  const consumer = '---\nextends: quoted.md\nmsg: "hello world"\n---\n';
  assert.equal(resolveTemplate(consumer, TMP_DIR), 'hello world');
});

// --- Block substitution ---

test('@block with @fill replaces default content', () => {
  writeFileSync(join(TMP_DIR, 'blocks.md'), 'Before\n@block(safety)\nDefault safety.\n@endblock\nAfter');
  const consumer = '---\nextends: blocks.md\n---\n@fill(safety)\nCustom safety content.\n@endfill\n';
  const result = resolveTemplate(consumer, TMP_DIR);
  assert.match(result, /Before\nCustom safety content.\nAfter/);
  assert.doesNotMatch(result, /Default safety/);
});

test('@block without @fill keeps default content', () => {
  writeFileSync(join(TMP_DIR, 'block-default.md'), 'Start\n@block(info)\nDefault info.\n@endblock\nEnd');
  const consumer = '---\nextends: block-default.md\n---\n';
  const result = resolveTemplate(consumer, TMP_DIR);
  assert.match(result, /Start\nDefault info.\nEnd/);
});

test('multiple blocks resolved independently', () => {
  writeFileSync(join(TMP_DIR, 'multi-block.md'), '@block(a)\nAA\n@endblock\n---\n@block(b)\nBB\n@endblock\n');
  const consumer = '---\nextends: multi-block.md\n---\n@fill(a)\nFilled-A\n@endfill\n';
  const result = resolveTemplate(consumer, TMP_DIR);
  assert.match(result, /Filled-A/);
  assert.match(result, /BB/);
  assert.doesNotMatch(result, /AA/);
});

// --- Conditionals ---

test('@if(var) includes content when var is defined', () => {
  writeFileSync(join(TMP_DIR, 'cond.md'), 'Start\n@if(show)\nVisible\n@endif\nEnd');
  const consumer = '---\nextends: cond.md\nshow: true\n---\n';
  const result = resolveTemplate(consumer, TMP_DIR);
  assert.match(result, /Start\nVisible\nEnd/);
});

test('@if(var) excludes content when var is missing', () => {
  writeFileSync(join(TMP_DIR, 'cond-miss.md'), 'Start\n@if(show)\nHidden\n@endif\nEnd');
  const consumer = '---\nextends: cond-miss.md\n---\n';
  const result = resolveTemplate(consumer, TMP_DIR);
  assert.match(result, /Start\nEnd/);
  assert.doesNotMatch(result, /Hidden/);
});

test('@if(!var) includes content when var is missing', () => {
  writeFileSync(join(TMP_DIR, 'cond-neg.md'), '@if(!premium)\nFree tier.\n@endif\n');
  const consumer = '---\nextends: cond-neg.md\n---\n';
  assert.match(resolveTemplate(consumer, TMP_DIR), /Free tier/);
});

test('@if(!var) excludes content when var is defined', () => {
  writeFileSync(join(TMP_DIR, 'cond-neg2.md'), '@if(!premium)\nFree tier.\n@endif\n');
  const consumer = '---\nextends: cond-neg2.md\npremium: yes\n---\n';
  assert.doesNotMatch(resolveTemplate(consumer, TMP_DIR), /Free tier/);
});

// --- Combined ---

test('vars inside blocks and conditionals are resolved', () => {
  writeFileSync(join(TMP_DIR, 'combined.md'), '@block(header)\n${greeting}\n@endblock\n@if(show_footer)\nFooter: ${footer_text:-default footer}\n@endif\n');
  const consumer = '---\nextends: combined.md\ngreeting: Hi\nshow_footer: yes\n---\n@fill(header)\nCustom: ${greeting}\n@endfill\n';
  const result = resolveTemplate(consumer, TMP_DIR);
  assert.match(result, /Custom: Hi/);
  assert.match(result, /Footer: default footer/);
});

// --- {{runtime}} vars pass through ---

test('{{runtime}} vars are not touched by template resolution', () => {
  writeFileSync(join(TMP_DIR, 'runtime.md'), '${name} at {{currentDateTime}}');
  const consumer = '---\nextends: runtime.md\nname: Agent\n---\n';
  assert.equal(resolveTemplate(consumer, TMP_DIR), 'Agent at {{currentDateTime}}');
});

// --- Error handling ---

test('missing template file falls back to body', () => {
  const consumer = '---\nextends: nonexistent.md\nfoo: bar\n---\nFallback body';
  assert.equal(resolveTemplate(consumer, TMP_DIR), 'Fallback body');
});
