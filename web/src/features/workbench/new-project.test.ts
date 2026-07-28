// input:  project-name and mutation-error fixtures
// output: new-project validation and error-mapping tests
// pos:    Verifies behavior of new-project helpers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import { canCreate, createErrorMessage } from './new-project';

describe('canCreate', () => {
  it('is false for empty / whitespace-only names', () => {
    expect(canCreate('')).toBe(false);
    expect(canCreate('   ')).toBe(false);
    expect(canCreate('\t\n')).toBe(false);
  });
  it('is true for a non-empty trimmed name', () => {
    expect(canCreate('nimbus')).toBe(true);
    expect(canCreate('  orchard  ')).toBe(true);
  });
});

describe('createErrorMessage', () => {
  it('surfaces the backend message from a tRPC-shaped error', () => {
    expect(createErrorMessage({ message: 'Project already exists: nimbus' })).toBe(
      'Project already exists: nimbus',
    );
    expect(createErrorMessage(new Error('Invalid project name: "a/b"'))).toBe(
      'Invalid project name: "a/b"',
    );
  });
  it('falls back to a neutral message when none is present', () => {
    expect(createErrorMessage({})).toBe('Could not create project.');
    expect(createErrorMessage(null)).toBe('Could not create project.');
    expect(createErrorMessage({ message: '   ' })).toBe('Could not create project.');
  });
});
