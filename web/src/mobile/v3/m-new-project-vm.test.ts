import { describe, it, expect } from 'vitest';
import { canCreate } from './m-new-project-vm';

describe('canCreate', () => {
  it('is false for an empty string', () => {
    expect(canCreate('')).toBe(false);
  });

  it('is false for whitespace-only', () => {
    expect(canCreate('   ')).toBe(false);
  });

  it('is true for a trimmed non-empty name', () => {
    expect(canCreate('rl-locomotion')).toBe(true);
  });

  it('is true when surrounded by whitespace but has content', () => {
    expect(canCreate('  rl  ')).toBe(true);
  });
});
