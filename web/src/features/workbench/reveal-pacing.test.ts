import { describe, it, expect } from 'vitest';
import {
  stepReveal, carryReveal, rebaseReveal, revealedText,
  SOURCE_CHUNK_CHARS, SOURCE_INTERVAL_MS, CATCHUP_BACKLOG_CHARS, SNAP_BACKLOG_CHARS, MIN_CHARS_PER_SEC,
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

describe('stepReveal — steady-state rate', () => {
  it('drains one source chunk over roughly one source interval', () => {
    // The defining rule: rate = backlog / one source interval, so the reveal runs about one
    // interval behind arrival instead of falling progressively further behind.
    expect(stepReveal(0, SOURCE_CHUNK_CHARS, 1)).toBeCloseTo(SOURCE_CHUNK_CHARS / SOURCE_INTERVAL_MS, 6);
  });

  it('scales the rate with the backlog below the catch-up knee', () => {
    const half = CATCHUP_BACKLOG_CHARS / 2;
    expect(stepReveal(0, half, 1)).toBeCloseTo(half / SOURCE_INTERVAL_MS, 6);
  });

  it('lifts a nearly-drained tail off the floor so the last characters never crawl', () => {
    // Proportional pacing alone would take ~350ms to show 2 remaining characters.
    expect(stepReveal(0, 2, 50)).toBe(2);
    expect(stepReveal(0, 2, 1)).toBeCloseTo(MIN_CHARS_PER_SEC / 1000, 6);
  });
});

describe('stepReveal — catch-up when the backlog grows', () => {
  it('reveals faster than the proportional rate once the backlog passes two chunks', () => {
    const big = CATCHUP_BACKLOG_CHARS * 2;
    const proportional = big / SOURCE_INTERVAL_MS;
    expect(stepReveal(0, big, 1)).toBeGreaterThan(proportional);
  });

  it('accelerates continuously — no jump at the catch-up knee', () => {
    const atKnee = stepReveal(0, CATCHUP_BACKLOG_CHARS, 1);
    const justPast = stepReveal(0, CATCHUP_BACKLOG_CHARS + 1, 1);
    expect(justPast).toBeGreaterThan(atKnee);
    expect(justPast - atKnee).toBeLessThan(0.05);
  });

  it('is monotonic in the backlog — more waiting always means a faster reveal', () => {
    let prev = 0;
    for (let backlog = 1; backlog < SNAP_BACKLOG_CHARS; backlog += 7) {
      const rate = stepReveal(0, backlog, 1);
      expect(rate).toBeGreaterThanOrEqual(prev);
      prev = rate;
    }
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

// ── Simulated stream against the measured source cadence ────────────────────────────────────────

/** One frame-by-frame run of the reveal against a source that appends `chunk` chars every
 *  `intervalMs`. Returns the worst lag seen and the frames needed to settle after the source stops. */
function simulate(opts: { chunk: number; intervalMs: number; chunks: number; frameMs?: number }): {
  maxBacklog: number;
  settled: boolean;
  framesAfterLastChunk: number;
  everViolatedPrefix: boolean;
} {
  const frameMs = opts.frameMs ?? 16;
  const full = 'x'.repeat(opts.chunk * opts.chunks);
  let buffer = '';
  let revealed = 0;
  let maxBacklog = 0;
  let everViolatedPrefix = false;
  let framesAfterLastChunk = 0;
  let delivered = 0;

  for (let t = 0; t < opts.intervalMs * opts.chunks + 20_000; t += frameMs) {
    // Source: a whole chunk lands every intervalMs.
    const due = Math.min(Math.floor(t / opts.intervalMs) + 1, opts.chunks);
    if (due > delivered) {
      delivered = due;
      buffer = full.slice(0, delivered * opts.chunk);
    }
    revealed = stepReveal(revealed, buffer.length, frameMs);
    if (!full.startsWith(revealedText(buffer, revealed))) everViolatedPrefix = true;
    if (delivered < opts.chunks) maxBacklog = Math.max(maxBacklog, buffer.length - revealed);
    else if (revealed < buffer.length) framesAfterLastChunk++;
    if (delivered === opts.chunks && revealed >= buffer.length) {
      return { maxBacklog, settled: true, framesAfterLastChunk, everViolatedPrefix };
    }
  }
  return { maxBacklog, settled: false, framesAfterLastChunk, everViolatedPrefix };
}

describe('simulated stream — the measured CLI cadence', () => {
  // 51 deltas of ~92 chars at ~350ms — the measured shape of a 4689-character reply.
  const measured = { chunk: SOURCE_CHUNK_CHARS, intervalMs: SOURCE_INTERVAL_MS, chunks: 51 };

  it('shows only text that has arrived, on every frame of a long reply', () => {
    expect(simulate(measured).everViolatedPrefix).toBe(false);
  });

  it('keeps the lag bounded instead of drifting further behind as the reply grows', () => {
    // The lag must not accumulate over 51 chunks — it settles near the catch-up knee and stays there.
    expect(simulate(measured).maxBacklog).toBeLessThan(CATCHUP_BACKLOG_CHARS);
  });

  it('catches up rather than trailing for seconds after the last chunk lands', () => {
    const { settled, framesAfterLastChunk } = simulate(measured);
    expect(settled).toBe(true);
    // Under a second of tail at 60fps.
    expect(framesAfterLastChunk).toBeLessThan(60);
  });

  it('keeps the lag bounded when the source runs much faster than measured', () => {
    // A backend that batches harder: 4x the characters in the same interval.
    const fast = { chunk: SOURCE_CHUNK_CHARS * 4, intervalMs: SOURCE_INTERVAL_MS, chunks: 30 };
    const { maxBacklog, everViolatedPrefix } = simulate(fast);
    expect(everViolatedPrefix).toBe(false);
    expect(maxBacklog).toBeLessThanOrEqual(SNAP_BACKLOG_CHARS);
  });

  it('settles a slow trickle without stalling', () => {
    const trickle = { chunk: 3, intervalMs: 400, chunks: 12 };
    expect(simulate(trickle).settled).toBe(true);
  });
});
