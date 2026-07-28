// input:  project names and caught create-project mutation errors
// output: creatability gate, modal copy, and safe error message
// pos:    New-project modal validation and error helpers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** Verbatim EN copy from the prototype (ZH toggle is Stage 8). */
export const NP_TITLE = 'New project';
export const NP_BREADCRUMB = 'context/projects/';
export const NP_LABEL = 'PROJECT NAME';
export const NP_PLACEHOLDER = 'nimbus';
export const NP_HINT = 'Becomes context/projects/<name>/ — the agent handles everything else';
export const NP_CREATE_LABEL = 'Create →';
export const NP_CANCEL = 'Cancel';

/** The trimmed name must be non-empty to create (prototype npCreate no-ops on empty). */
export function canCreate(name: string): boolean {
  return name.trim().length > 0;
}

/**
 * Surface the real backend error verbatim (ProjectStore → tRPC TRPCError message:
 * "Project already exists: X" / "Invalid project name: …"). No fabricated copy — falls back to a
 * neutral message only when the error carries none.
 */
export function createErrorMessage(err: unknown): string {
  const message =
    err && typeof err === 'object' && 'message' in err
      ? (err as { message?: unknown }).message
      : undefined;
  if (typeof message === 'string' && message.trim().length > 0) return message;
  return 'Could not create project.';
}
