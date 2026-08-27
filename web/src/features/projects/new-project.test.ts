// input:  project-name and mutation-error fixtures
// output: shared new-project validation and error regressions
// pos:    Project creation helper unit specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { canCreateProject, projectCreateErrorMessage } from './new-project';

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

describe('projectCreateErrorMessage', () => {
  it('surfaces the real backend message', () => {
    expect(projectCreateErrorMessage({ message: 'Project already exists: nimbus' })).toBe(
      'Project already exists: nimbus',
    );
    expect(projectCreateErrorMessage(new Error('Invalid project name: "a/b"'))).toBe(
      'Invalid project name: "a/b"',
    );
  });

  it('uses a neutral fallback when no message exists', () => {
    expect(projectCreateErrorMessage({})).toBe('Could not create project.');
    expect(projectCreateErrorMessage(null)).toBe('Could not create project.');
    expect(projectCreateErrorMessage({ message: '   ' })).toBe('Could not create project.');
  });
});
