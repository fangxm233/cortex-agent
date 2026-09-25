import { describe, it, expect } from 'vitest';
import {
  stepReveal, carryReveal, rebaseReveal, revealedText,
  SNAP_BACKLOG_CHARS,
} from './reveal-pacing';

// Pacing math for the smooth reveal of streamed assistant text. The source cadence is the CLI's:
// measured at ~92 characters per delta arriving every ~350ms (2.9 updates/second), i.e. about a line
// at a time. These tests lock the three properties the reveal must have — the revealed string is
// always a PREFIX of what arrived (pacing, never prediction), the lag stays bounded when the backlog
// grows, and a backlog too large to pace is shown at once.

describe('stepReveal — never outruns the buffer', () => {
  it('reveals nothing when nothing has arrived', () => {
    expect(stepReveal(0, 0, 16)).toBe(0);
  });

  it('clamps to what has arrived even for an absurd frame gap', () => {
    expect(stepReveal(0, 10, 100_000)).toBe(10);
  });

  it('clamps to what has arrived when almost caught up', () => {
    expect(stepReveal(90, 92, 1000)).toBe(92);
  });

  it('never moves backwards on a zero or negative frame gap', () => {
    expect(stepReveal(40, 92, 0)).toBe(40);
    expect(stepReveal(40, 92, -8)).toBe(40);
  });

  it('drops back to the buffer when it shrinks (a new block replaced it)', () => {
    expect(stepReveal(500, 10, 16)).toBe(10);
  });
});

describe('stepReveal — instant settle above the hard lag bound', () => {
  it('shows the whole buffer in one step once the backlog is beyond pacing', () => {
    expect(stepReveal(0, SNAP_BACKLOG_CHARS, 1)).toBe(SNAP_BACKLOG_CHARS);
    expect(stepReveal(0, 5000, 1)).toBe(5000);
    // Switching into a session whose reply is already long must not replay it.
    expect(stepReveal(120, 4689, 1)).toBe(4689);
  });

  it('still paces a backlog just under the bound', () => {
    expect(stepReveal(0, SNAP_BACKLOG_CHARS - 1, 1)).toBeLessThan(SNAP_BACKLOG_CHARS - 1);
  });
});

describe('carryReveal — the revealed prefix survives only a real extension', () => {
  it('keeps the revealed count when the buffer extends', () => {
    expect(carryReveal('Tea begins', 'Tea begins as a leaf', 6)).toBe(6);
  });

  it('keeps the revealed count when the buffer is unchanged', () => {
    expect(carryReveal('Tea begins', 'Tea begins', 6)).toBe(6);
  });

  it('restarts when the buffer is a different block, not an extension', () => {
    expect(carryReveal('Tea begins', 'Coffee begins as a bean', 6)).toBe(0);
  });

  it('restarts when the buffer shrank (a rewind, or a fresh block)', () => {
    expect(carryReveal('Tea begins as a leaf', 'Tea', 12)).toBe(0);
  });

  it('restarts from an empty previous buffer without carrying anything stale', () => {
    expect(carryReveal('', 'Tea begins', 0)).toBe(0);
  });

  it('never carries more than the new buffer holds', () => {
    expect(carryReveal('Tea begins', 'Tea begins', 999)).toBe(10);
  });
});

describe('rebaseReveal — a stream switch settles, it does not replay', () => {
  it('carries progress while the stream identity is unchanged', () => {
    expect(rebaseReveal(
      { streamKey: 's1', text: 'Tea begins', revealed: 6 },
      { streamKey: 's1', text: 'Tea begins as a leaf' },
    )).toBe(6);
  });

  it('restarts on a new block within the same stream', () => {
    expect(rebaseReveal(
      { streamKey: 's1', text: 'Tea begins', revealed: 6 },
      { streamKey: 's1', text: 'Coffee begins' },
    )).toBe(0);
  });

  it('shows everything at once when the stream identity changes (session switch)', () => {
    // What is already accumulated is not new to whoever just switched in — and it must never be
    // paced from the previous session's progress.
    expect(rebaseReveal(
      { streamKey: 's1', text: 'Tea begins', revealed: 4 },
      { streamKey: 's2', text: 'A different reply, already long' },
    )).toBe('A different reply, already long'.length);
  });

  it('settles a switched-in stream even when its text coincidentally extends the old one', () => {
    // The stale-state bleed that an identity check exists to make structurally impossible.
    expect(rebaseReveal(
      { streamKey: 's1', text: 'I will ', revealed: 2 },
      { streamKey: 's2', text: 'I will look into that' },
    )).toBe('I will look into that'.length);
  });

  it('handles a switch into a stream with no text yet', () => {
    expect(rebaseReveal({ streamKey: 's1', text: 'Tea', revealed: 3 }, { streamKey: 's2', text: '' })).toBe(0);
  });
});

describe('revealedText — the displayed string is always a prefix', () => {
  it('slices on whole characters', () => {
    expect(revealedText('Tea begins as a leaf', 3.9)).toBe('Tea');
  });

  it('never returns more than the buffer holds', () => {
    expect(revealedText('Tea', 99)).toBe('Tea');
  });

  it('never returns a negative slice', () => {
    expect(revealedText('Tea', -5)).toBe('');
  });
});

