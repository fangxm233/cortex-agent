// input:  Node test runner + cli-utils module
// output: formatHelp + formatError regression tests
// pos:    Verify shared CLI utilities rendering behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatHelp, formatError } from '../src/core/cli-utils.js';

test('formatHelp renders usage, commands, options, and examples', () => {
  const help = formatHelp({
    name: 'test-cli',
    description: 'A test CLI tool',
    usage: 'test-cli <command> [options]',
    commands: [
      { name: 'run', description: 'Run something' },
      { name: 'stop', description: 'Stop something' },
    ],
    options: [
      { flag: '--verbose', description: 'Enable verbose output', default: 'false' },
      { flag: '--output <path>', description: 'Output file path' },
    ],
    examples: [
      { description: 'Basic run', command: 'test-cli run --verbose' },
    ],
  });

  assert.match(help, /A test CLI tool/);
  assert.match(help, /Usage: test-cli <command> \[options\]/);
  assert.match(help, /Commands:/);
  assert.match(help, /run\s+Run something/);
  assert.match(help, /stop\s+Stop something/);
  assert.match(help, /Options:/);
  assert.match(help, /--verbose\s+Enable verbose.*\(default: false\)/);
  assert.match(help, /--output <path>\s+Output file path/);
  assert.match(help, /Examples:/);
  assert.match(help, /# Basic run/);
  assert.match(help, /test-cli run --verbose/);
});

test('formatHelp renders command groups', () => {
  const help = formatHelp({
    name: 'grouped-cli',
    description: 'Grouped commands',
    usage: 'grouped-cli <command>',
    commandGroups: [
      { heading: 'State', commands: [{ name: 'claim', description: 'Claim it' }] },
      { heading: 'Mutation', commands: [{ name: 'add', description: 'Add it' }] },
    ],
  });

  assert.match(help, /State:/);
  assert.match(help, /claim\s+Claim it/);
  assert.match(help, /Mutation:/);
  assert.match(help, /add\s+Add it/);
});

test('formatError includes valid values and hint when provided', () => {
  const msg1 = formatError('invalid status: foo');
  assert.equal(msg1, 'invalid status: foo');

  const msg2 = formatError('invalid status: foo', { validValues: ['open', 'closed'] });
  assert.match(msg2, /Valid values: open, closed/);

  const msg3 = formatError('missing flag', { hint: 'Try --help' });
  assert.match(msg3, /Hint: Try --help/);

  const msg4 = formatError('bad input', { validValues: ['a', 'b'], hint: 'See docs' });
  assert.match(msg4, /Valid values: a, b/);
  assert.match(msg4, /Hint: See docs/);
});

