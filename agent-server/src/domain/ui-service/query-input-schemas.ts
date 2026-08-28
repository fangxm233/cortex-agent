// input:  Zod plus UI-service query parameter contracts
// output: shared query input schemas for sessions, threads, and tasks
// pos:    Extracted query-schema leaf to keep ui-service validators modular
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { z } from 'zod';

export const sessionsListInput = z.object({
  projectId: z.string().optional(),
  resumable: z.boolean().optional(),
  origin: z.enum(['direct', 'thread', 'scheduled']).optional(),
});

export const sessionsTranscriptInput = z.object({
  sessionId: z.string(),
  compactSubagents: z.boolean().optional(),
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

export const threadsListInput = z.object({
  projectId: z.string().optional(),
  status: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
});

export const threadsGetInput = z.object({
  threadId: z.string(),
  includeArtifactContent: z.boolean().optional(),
});

export const tasksListInput = z.object({
  projectId: z.string().optional(),
  status: z.enum(['open', 'done']).optional(),
  actionable: z.boolean().optional(),
});

export const taskVerificationInput = z.object({
  projectId: z.string(),
  taskId: z.string(),
});

export const schedulesListInput = z.object({
  projectId: z.string().optional(),
  paused: z.boolean().optional(),
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
  path: z.string(),
});

export const approvalsListInput = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(),
});

export const issuesListInput = z.object({
  projectId: z.string(),
});

export const notesListInput = z.object({
  projectId: z.string(),
});
