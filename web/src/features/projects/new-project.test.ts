import { describe, expect, it } from 'vitest';
import { canCreateProject } from './new-project';

describe('canCreateProject', () => {
  it('rejects empty and whitespace-only names', () => {
    expect(canCreateProject('')).toBe(false);
    expect(canCreateProject('   ')).toBe(false);
    expect(canCreateProject('\t\n')).toBe(false);
  });

  it('accepts non-empty trimmed names', () => {
    expect(canCreateProject('nimbus')).toBe(true);
    expect(canCreateProject('  orchard  ')).toBe(true);
  });
});
