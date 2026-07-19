import { describe, expect, it } from 'vitest';
import { posterCanvasSize, posterSeekTime } from './video-poster';

describe('posterCanvasSize', () => {
  it('returns zero for non-positive dimensions', () => {
    expect(posterCanvasSize(0, 100)).toEqual({ w: 0, h: 0 });
    expect(posterCanvasSize(100, 0)).toEqual({ w: 0, h: 0 });
    expect(posterCanvasSize(-4, -4)).toEqual({ w: 0, h: 0 });
  });

  it('keeps small frames at native size (no upscale)', () => {
    expect(posterCanvasSize(320, 240)).toEqual({ w: 320, h: 240 });
  });

  it('downscales a large frame so the longest edge fits the cap, preserving aspect', () => {
    // 1920x1080, cap 360 → scale 360/1920 = 0.1875 → 360x202.5 → rounded 360x203
    expect(posterCanvasSize(1920, 1080)).toEqual({ w: 360, h: 203 });
  });

  it('caps by the taller edge for portrait frames', () => {
    // 1080x1920, cap 360 → scale 360/1920 → 202.5x360 → 203x360
    expect(posterCanvasSize(1080, 1920)).toEqual({ w: 203, h: 360 });
  });

  it('honors a custom cap', () => {
    expect(posterCanvasSize(1000, 500, 100)).toEqual({ w: 100, h: 50 });
  });
});

describe('posterSeekTime', () => {
  it('seeks a small fixed offset into a normal clip', () => {
    expect(posterSeekTime(30)).toBeCloseTo(0.1);
  });

  it('never seeks past the midpoint of a very short clip', () => {
    expect(posterSeekTime(0.1)).toBeCloseTo(0.05);
  });

  it('falls back to a tiny offset when duration is unknown (0 / NaN / Infinity)', () => {
    expect(posterSeekTime(0)).toBeCloseTo(0.1);
    expect(posterSeekTime(Number.NaN)).toBeCloseTo(0.1);
    expect(posterSeekTime(Number.POSITIVE_INFINITY)).toBeCloseTo(0.1);
  });
});
