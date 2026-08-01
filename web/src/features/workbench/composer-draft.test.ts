// input:  composer draft helpers and attachment metadata
// output: storage key, parsing, prefill, and failed-send restore tests
// pos:    Tests persistent desktop/mobile composer drafts
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import {
  draftStorageKey,
  isDraftEmpty,
  parseDraft,
  serializeDraft,
  mergeDraftPrefill,
  mergeRestoredDraft,
  DRAFT_KEY_PREFIX,
  type ComposerDraft,
} from './composer-draft';
import type { AttachmentMeta } from './chat-content';

const meta = (name: string): AttachmentMeta => ({
  name,
  path: `workspace/attachments/sess-1/${name}`,
  size: 123,
  mimeType: 'image/png',
  type: 'image',
});

describe('draftStorageKey', () => {
  it('keys a real session by its session id', () => {
    expect(draftStorageKey({ isDraft: false, sessionId: 'abc' })).toBe(`${DRAFT_KEY_PREFIX}session.abc`);
  });
  it('keys a new-session draft per project', () => {
    expect(draftStorageKey({ isDraft: true, projectId: 'cortex-self' })).toBe(`${DRAFT_KEY_PREFIX}new.cortex-self`);
  });
  it('falls back to general for a draft with no project', () => {
    expect(draftStorageKey({ isDraft: true })).toBe(`${DRAFT_KEY_PREFIX}new.general`);
  });
  it('returns null for a non-draft with no session id (nothing stable to key on)', () => {
    expect(draftStorageKey({ isDraft: false })).toBeNull();
    expect(draftStorageKey({ isDraft: false, sessionId: '' })).toBeNull();
  });
});

describe('isDraftEmpty', () => {
  it('treats null / whitespace-only / no attachments as empty', () => {
    expect(isDraftEmpty(null)).toBe(true);
    expect(isDraftEmpty({ text: '   ', attachments: [] })).toBe(true);
  });
  it('is non-empty with real text or any attachment', () => {
    expect(isDraftEmpty({ text: 'hi', attachments: [] })).toBe(false);
    expect(isDraftEmpty({ text: '', attachments: [meta('a.png')] })).toBe(false);
  });
});

describe('mergeDraftPrefill', () => {
  it('replaces draft text while preserving uploaded attachments and their draft id', () => {
    const existing: ComposerDraft = {
      text: 'old draft',
      attachments: [meta('keep.png')],
      draftUploadId: 'upload-1',
    };
    expect(mergeDraftPrefill(existing, 'private reminder')).toEqual({
      text: 'private reminder',
      attachments: [meta('keep.png')],
      draftUploadId: 'upload-1',
    });
  });

  it('creates an attachment-free draft when none exists', () => {
    expect(mergeDraftPrefill(null, 'private reminder')).toEqual({
      text: 'private reminder',
      attachments: [],
    });
  });
});

describe('mergeRestoredDraft', () => {
  it('restores a rejected send without overwriting text typed while it was pending', () => {
    expect(mergeRestoredDraft(
      { text: 'new thought', attachments: [meta('new.png')] },
      { text: 'failed message', attachments: [meta('sent.png')], draftUploadId: 'upload-1' },
    )).toEqual({
      text: 'failed message\nnew thought',
      attachments: [meta('sent.png'), meta('new.png')],
      draftUploadId: 'upload-1',
    });
  });

  it('deduplicates already-restored attachments by server path', () => {
    expect(mergeRestoredDraft(
      { text: '', attachments: [meta('same.png')], draftUploadId: 'current-upload' },
      { text: '', attachments: [meta('same.png')], draftUploadId: 'sent-upload' },
    )).toEqual({
      text: '',
      attachments: [meta('same.png')],
      draftUploadId: 'current-upload',
    });
  });
});

describe('parseDraft / serializeDraft round-trip', () => {
  it('round-trips text + attachments + draftUploadId', () => {
    const d: ComposerDraft = { text: 'hello', attachments: [meta('a.png')], draftUploadId: 'uid-1' };
    const back = parseDraft(serializeDraft(d));
    expect(back).toEqual(d);
  });
  it('omits draftUploadId when absent', () => {
    const d: ComposerDraft = { text: 'hi', attachments: [] };
    const back = parseDraft(serializeDraft(d));
    expect(back).toEqual({ text: 'hi', attachments: [] });
    expect(back && 'draftUploadId' in back).toBe(false);
  });
  it('returns null for empty / malformed / non-object input', () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('')).toBeNull();
    expect(parseDraft('{ not json')).toBeNull();
    expect(parseDraft('"a string"')).toBeNull();
    expect(parseDraft(JSON.stringify({ text: '', attachments: [] }))).toBeNull();
  });
  it('drops malformed attachment entries but keeps valid ones', () => {
    const raw = JSON.stringify({ text: 't', attachments: [meta('ok.png'), { name: 'bad' }, 42, null] });
    const back = parseDraft(raw);
    expect(back?.attachments).toEqual([meta('ok.png')]);
  });
  it('coerces a missing text field to empty string', () => {
    const back = parseDraft(JSON.stringify({ attachments: [meta('a.png')] }));
    expect(back).toEqual({ text: '', attachments: [meta('a.png')] });
  });
});
