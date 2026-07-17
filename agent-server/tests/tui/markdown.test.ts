// input:  src/tui/render/markdown.js
// output: Unit tests for minimal markdown parser
// pos:    Verifies bold/italic/code/link parsing

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../../src/tui/render/markdown.js';

test('parseMarkdown parses bold text', () => {
  const result = parseMarkdown('hello **world**');
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].text, 'hello ');
  assert.equal(result[1].type, 'bold');
  assert.equal(result[1].text, 'world');
});

test('parseMarkdown parses italic text', () => {
  const result = parseMarkdown('hello *world*');
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'text');
  assert.equal(result[1].type, 'italic');
  assert.equal(result[1].text, 'world');
});

test('parseMarkdown parses inline code', () => {
  const result = parseMarkdown('use `code` here');
  assert.equal(result.length, 3);
  assert.equal(result[1].type, 'code');
  assert.equal(result[1].text, 'code');
});

test('parseMarkdown parses links', () => {
  const result = parseMarkdown('visit [example](https://example.com) now');
  assert.equal(result.length, 3);
  assert.equal(result[1].type, 'link');
  assert.equal(result[1].text, 'example');
  assert.equal(result[1].url, 'https://example.com');
});

test('parseMarkdown returns plain text when no formatting', () => {
  const result = parseMarkdown('hello world');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].text, 'hello world');
});

test('parseMarkdown returns empty array for empty string', () => {
  const result = parseMarkdown('');
  assert.equal(result.length, 0);
});

test('parseMarkdown handles combined formatting', () => {
  const result = parseMarkdown('**bold** and *italic* and `code`');
  assert.ok(result.some(s => s.type === 'bold'));
  assert.ok(result.some(s => s.type === 'italic'));
  assert.ok(result.some(s => s.type === 'code'));
});
