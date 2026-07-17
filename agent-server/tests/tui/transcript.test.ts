// input:  src/tui/hooks/useTranscript.js (pure state helpers)
// output: Unit tests for transcript data model
// pos:    Verifies chat.post/update/delete/queued and stream frame handlers

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  _handleChatPost, _handleChatUpdate, _handleChatDelete, _handleChatMarkQueued,
  _handleStreamText, _handleStreamMutableOpen, _handleStreamMutableUpdate,
} from '../../src/tui/hooks/useTranscript.js';

// ── Fixtures ──

const REF = { conduit: 'tui:abc-123', messageId: 'm-001', threadId: 'anchor-1' };

function makeChatPost(messageId: string, text: string, seq = 1) {
  return { type: 'chat.post' as const, ref: { ...REF, messageId }, content: { text }, seq };
}

function makeChatUpdate(messageId: string, text: string, seq = 2) {
  return { type: 'chat.update' as const, ref: { ...REF, messageId }, content: { text }, seq };
}

function makeChatDelete(messageId: string, seq = 3) {
  return { type: 'chat.delete' as const, ref: { ...REF, messageId }, seq };
}

function makeChatMarkQueued(messageId: string, seq = 4) {
  return { type: 'chat.markQueued' as const, ref: { ...REF, messageId }, seq };
}

function makeStreamText(streamId: string, text: string, seq = 5) {
  return { type: 'stream.text' as const, streamId, text, seq };
}

function makeStreamMutableOpen(streamId: string, regionId: string, text: string, seq = 6) {
  return { type: 'stream.mutableOpen' as const, streamId, regionId, text, seq };
}

function makeStreamMutableUpdate(streamId: string, regionId: string, text: string, seq = 7) {
  return { type: 'stream.mutableUpdate' as const, streamId, regionId, text, seq };
}

const EMPTY = { messages: new Map(), ids: [] as string[] };

// ── Tests ──

test('chat.post inserts message into transcript', () => {
  const state = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  assert.equal(state.ids.length, 1);
  assert.equal(state.ids[0], 'm-001');
  assert.equal(state.messages.get('m-001')?.text, 'hello');
  assert.equal(state.messages.get('m-001')?.queued, false);
});

test('chat.post deduplicates by messageId', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleChatPost(s1, makeChatPost('m-001', 'hello'));
  assert.equal(s2.ids.length, 1); // no duplicate
});

test('chat.post preserves insertion order across multiple messages', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'first'));
  const s2 = _handleChatPost(s1, makeChatPost('m-002', 'second'));
  assert.deepEqual(s2.ids, ['m-001', 'm-002']);
});

test('chat.update replaces text by messageId', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleChatUpdate(s1, makeChatUpdate('m-001', 'updated'));
  assert.equal(s2.messages.get('m-001')?.text, 'updated');
});

test('chat.update ignores unknown messageId', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleChatUpdate(s1, makeChatUpdate('m-999', 'nope'));
  assert.equal(s2.ids.length, 1); // unchanged
});

test('chat.delete removes message by messageId', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleChatDelete(s1, makeChatDelete('m-001'));
  assert.equal(s2.ids.length, 0);
  assert.equal(s2.messages.has('m-001'), false);
});

test('chat.delete ignores unknown messageId', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleChatDelete(s1, makeChatDelete('m-999'));
  assert.equal(s2.ids.length, 1);
});

test('chat.markQueued sets queued flag', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleChatMarkQueued(s1, makeChatMarkQueued('m-001'));
  assert.equal(s2.messages.get('m-001')?.queued, true);
});

test('stream.text appends to last message stream', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleStreamText(s1, makeStreamText('s1', 'part1'));
  const msg = s2.messages.get('m-001');
  assert.ok(msg);
  assert.equal(msg.streams.get('s1')?.blocks.length, 1);
  assert.equal(msg.streams.get('s1')?.blocks[0].text, 'part1');
});

test('stream.text appends multiple segments to same stream', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleStreamText(s1, makeStreamText('s1', 'part1'));
  const s3 = _handleStreamText(s2, makeStreamText('s1', 'part2'));
  assert.equal(s3.messages.get('m-001')?.streams.get('s1')?.blocks.length, 2);
  assert.equal(s3.messages.get('m-001')?.streams.get('s1')?.blocks[1].text, 'part2');
});

test('stream.mutableOpen opens a mutable region', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleStreamMutableOpen(s1, makeStreamMutableOpen('s1', 'r1', 'initial'));
  const region = s2.messages.get('m-001')?.streams.get('s1')?.blocks.find(b => b.kind === 'region' && b.regionId === 'r1');
  assert.ok(region);
  assert.equal(region.text, 'initial');
});

test('stream.mutableUpdate replaces region content', () => {
  const s1 = _handleChatPost(EMPTY, makeChatPost('m-001', 'hello'));
  const s2 = _handleStreamMutableOpen(s1, makeStreamMutableOpen('s1', 'r1', 'initial'));
  const s3 = _handleStreamMutableUpdate(s2, makeStreamMutableUpdate('s1', 'r1', 'updated'));
  assert.equal(s3.messages.get('m-001')?.streams.get('s1')?.blocks.find(b => b.kind === 'region' && b.regionId === 'r1')?.text, 'updated');
});

