import { test } from 'vitest';
import assert from 'node:assert/strict';
import { boardActionFromToolResult, boardOpenedHeadline, isBoardOpenTool } from '../../src/core/board-action.js';
import { openedText } from '../../src/domain/mcp/tools/ui-board.js';

test('board_open is recognized under any server prefix', () => {
  assert.equal(isBoardOpenTool('board_open'), true);
  assert.equal(isBoardOpenTool('mcp__cortex-web__board_open'), true);
  assert.equal(isBoardOpenTool('cortex-web.board_open'), true);
  assert.equal(isBoardOpenTool('mcp__cortex-web__board_close'), false);
  assert.equal(isBoardOpenTool('send_view'), false);
});

test('the board_open result reads back as the board action it reports', () => {
  const text = (created: boolean, title: string) => openedText({ id: 'a1b2c3d4', title, dir: '/ctx/boards/x', created, bound: ['s1'] });
  assert.deepEqual(boardActionFromToolResult(text(true, 'Ship it')), { op: 'open', boardId: 'a1b2c3d4', title: 'Ship it', created: true });
  assert.deepEqual(boardActionFromToolResult(text(false, 'Ship it')), { op: 'open', boardId: 'a1b2c3d4', title: 'Ship it', created: false });
  // Quotes, parentheses and a line break in the title survive.
  const awkward = 'Say "hi" (v2). “ok”\nnext';
  assert.deepEqual(boardActionFromToolResult(text(true, awkward)), { op: 'open', boardId: 'a1b2c3d4', title: awkward, created: true });
  assert.equal(boardOpenedHeadline({ id: 'x', title: 'T', created: false }), 'Attached to board "T" (x).');
});

test('anything that is not a board_open success reads as no action', () => {
  assert.equal(boardActionFromToolResult('board_open failed: no board "nope" in project p'), null);
  assert.equal(boardActionFromToolResult('Created board "T" (x).'), null, 'the directory line is part of the shape');
  assert.equal(boardActionFromToolResult(''), null);
});
