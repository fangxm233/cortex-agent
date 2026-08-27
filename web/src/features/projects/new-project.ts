// input:  project names and caught create-project mutation errors
// output: shared create gate, desktop copy constants, and safe error text
// pos:    Cross-surface new-project validation helpers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export const NP_BREADCRUMB = 'context/projects/';
export const NP_PLACEHOLDER = 'nimbus';

/** A trimmed project name must contain content before either surface may submit it. */
export function canCreateProject(name: string): boolean {
  return name.trim().length > 0;
}

/** Preserve a real backend error message; use neutral copy only when none is available. */
export function projectCreateErrorMessage(error: unknown): string {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? (error as { message?: unknown }).message
      : undefined;
  if (typeof message === 'string' && message.trim().length > 0) return message;
  return 'Could not create project.';
}
