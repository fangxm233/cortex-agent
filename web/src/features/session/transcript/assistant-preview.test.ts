import { describe, expect, it } from 'vitest';
import {
  applyAssistantPreviewDelta as apply, finalizeAssistantPreview as finalize,
  initialAssistantPreviewState as initial,
} from './transcript-vm';

describe('assistant preview snapshots and sequence ordering', () => {
  it('replaces with a cumulative snapshot, then appends only newer increments', () => {
    let state = apply(initial(), { blockId: 'b', text: 'pre', seq: 0 });
    state = apply(state, { blockId: 'b', text: 'prefix', seq: 2, snapshot: true });
    expect(state.active?.text).toBe('prefix');
    expect(apply(state, { blockId: 'b', text: 'prefix', seq: 2, snapshot: true })).toBe(state);
    expect(apply(state, { blockId: 'b', text: 'old', seq: 1, snapshot: true })).toBe(state);
    expect(apply(state, { blockId: 'b', text: 'duplicate', seq: 2 })).toBe(state);
    state = apply(state, { blockId: 'b', text: ' suffix', seq: 3 });
    expect(state.active?.text).toBe('prefix suffix');
  });

  it('repairs a lost prefix from a same-seq snapshot without duplicating text', () => {
    let state = apply(initial(), { blockId: 'b', text: 'suffix', seq: 2 });
    state = apply(state, { blockId: 'b', text: 'prefix suffix', seq: 2, snapshot: true });
    expect(state.active?.text).toBe('prefix suffix');
  });

  it('accepts a new block with restarted seq and legacy events without seq', () => {
    let state = apply(initial(), { blockId: 'b', text: 'old', seq: 8 });
    state = apply(state, { blockId: 'c', text: 'new', seq: 0, snapshot: true });
    state = apply(state, { blockId: 'c', text: ' legacy' });
    expect(state.active?.text).toBe('new legacy');
    expect(apply(state, { blockId: 'c', text: 'duplicate', seq: 0 })).toBe(state);
  });

  it('empty snapshot seals a partial preview after a completion missed while disconnected', () => {
    let state = apply(initial(), { blockId: 'b', text: 'partial', seq: 0 });
    state = apply(state, { snapshot: true, text: '' });
    expect(state.active).toBeNull();
    expect(state.finalizedBlockIds).toContain('b');
    expect(apply(state, { blockId: 'b', text: 'late', seq: 1 })).toBe(state);
  });

  it('snapshots cannot reopen finalized blocks, including when finalization arrived first', () => {
    const state = finalize(initial(), 'b');
    expect(apply(state, { blockId: 'b', text: 'whole', seq: 5, snapshot: true })).toBe(state);
    const next = apply(state, { blockId: 'c', text: 'current', seq: 0 });
    expect(finalize(next, 'b').active?.text).toBe('current');
  });
});
