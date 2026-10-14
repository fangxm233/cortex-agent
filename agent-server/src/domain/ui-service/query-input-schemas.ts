import { z } from 'zod';

export const sessionsListInput = z.object({
  projectId: z.string().optional(),
  resumable: z.boolean().optional(),
  /** Restrict to a single initiation origin. The workbench left rail passes 'direct' so
   *  only user conversations show; thread/scheduled sessions live in their own views. */
  origin: z.enum(['direct', 'thread', 'scheduled']).optional(),
});

export const sessionsTranscriptInput = z.object({
  sessionId: z.string(),
  compactSubagents: z.boolean().optional(),
  /** Cursor from a previous response. Asks for the rows that changed since it, not the transcript. */
  since: z.string().max(64).optional(),
});

export const sessionsSubagentTranscriptInput = z.object({
  sessionId: z.string(),
  subagentId: z.string().min(1).max(512),
});

export const sessionsDebugDetailsInput = z.object({
  sessionId: z.string(),
  ref: z.string().min(1).max(512),
});

export const sessionsPendingInteractionInput = z.object({
  sessionId: z.string().min(1),
});

export const schedulesListInput = z.object({
  projectId: z.string().optional(),
  paused: z.boolean().optional(),
});

export const boardsListInput = z.object({
  projectId: z.string().optional(),
  status: z.enum(['active', 'done', 'abandoned']).optional(),
});

export const boardsGetInput = z.object({
  boardId: z.string(),
});

export const boardsDecisionsInput = z.object({
  boardId: z.string(),
});

export const boardsStyleInput = z.object({});

/** Waitpoints belonging to ONE session. Scoped server-side: the client cannot compute the match
 *  because SessionInfo carries no `channel` (see WaitpointInfo for the ownership rule). */
export const waitpointsListInput = z.object({
  sessionId: z.string().min(1),
});

export const executionsListInput = z.object({
  status: z.array(z.string()).optional(),
  limit: z.number().optional(),
});

export const executionsGetInput = z.object({
  executionId: z.string(),
});

export const memoryTreeInput = z.object({
  projectId: z.string(),
});

export const memoryFileInput = z.object({
  projectId: z.string(),
  /** Path relative to the project root. Absolute paths / `..` traversal / symlink escape are rejected. */
  path: z.string(),
});

export const approvalsListInput = z.object({
  /** Filter to a single approval status. Omitted → all entries. */
  status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(),
});

export const issuesListInput = z.object({
  /** Issues are per-project (`<contextDir>/ISSUES.md`) — the project is required. */
  projectId: z.string(),
});

export const notesListInput = z.object({
  projectId: z.string(),
});
