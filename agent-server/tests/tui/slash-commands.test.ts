// input:  src/tui/slash-commands.js
// output: Unit tests for the slash-command registry helpers
// pos:    Guards the `/` palette parse/filter behaviour

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  SLASH_COMMANDS,
  parseSlashInput,
  filterSlashCommands,
  findSlashCommand,
} from '../../src/tui/slash-commands.js';

test('registry contains the button-replacement commands', () => {
  const names = SLASH_COMMANDS.map(c => c.name);
  for (const n of ['new', 'newx', 'resume']) {
    assert.ok(names.includes(n), `expected /${n} in the registry`);
  }
});

test('registry contains the restart command', () => {
  const names = SLASH_COMMANDS.map(c => c.name);
  assert.ok(names.includes('restart'), 'expected /restart in the registry');
});

test('parseSlashInput: non-slash text is not a command', () => {
  const p = parseSlashInput('hello world');
  assert.equal(p.isSlash, false);
});

test('parseSlashInput: bare command, no args', () => {
  const p = parseSlashInput('/new');
  assert.deepEqual(p, { isSlash: true, query: 'new', args: '' });
});

test('parseSlashInput: command with args, lowercased name', () => {
  const p = parseSlashInput('/Resume my-session');
  assert.equal(p.isSlash, true);
  assert.equal(p.query, 'resume');
  assert.equal(p.args, 'my-session');
});

test('filterSlashCommands: prefix match', () => {
  const r = filterSlashCommands('ne');
  const names = r.map(c => c.name);
  assert.deepEqual(names, ['new', 'newx']);
});

test('filterSlashCommands: empty query returns all', () => {
  assert.equal(filterSlashCommands('').length, SLASH_COMMANDS.length);
});

test('filterSlashCommands: no match returns empty', () => {
  assert.equal(filterSlashCommands('zzz').length, 0);
});

test('findSlashCommand: exact match and miss', () => {
  assert.equal(findSlashCommand('newx')?.name, 'newx');
  assert.equal(findSlashCommand('new ')?.name ?? null, null); // trailing space → no exact
  assert.equal(findSlashCommand('nope'), null);
});
