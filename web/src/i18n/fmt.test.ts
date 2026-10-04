import { describe, expect, it } from 'vitest';
import { fmt } from './fmt';

describe('fmt', () => {
  it('fills every occurrence and keeps unknown placeholders', () => {
    expect(fmt('{n} of {n} · {x}', { n: 3 })).toBe('3 of 3 · {x}');
  });
});
