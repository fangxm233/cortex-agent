import { z } from 'zod';

export const sessionsSetStarredInput = z.object({
  sessionId: z.string().min(1),
  starred: z.boolean(),
});

export const sessionsRenameInput = z.object({
  sessionId: z.string().min(1),
  label: z.string().trim().min(1).max(60),
});

export type SessionsSetStarredArgs = z.infer<typeof sessionsSetStarredInput>;
export type SessionsSetStarredReturn = SessionsSetStarredArgs;
export type SessionsRenameArgs = z.infer<typeof sessionsRenameInput>;
export type SessionsRenameReturn = SessionsRenameArgs;
