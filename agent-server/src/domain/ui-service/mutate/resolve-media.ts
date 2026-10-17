import { sessionsResolveMediaInput } from '../input-schemas.js';
import type { ResolveMediaInput, ResolveMediaResult } from '../inline-media-types.js';
import type { Result, UiServiceDeps } from '../types.js';

/** Media failures are successful RPC replies so the UI can translate their stable codes. */
export async function handleResolveMedia(
  deps: UiServiceDeps, args: ResolveMediaInput,
): Promise<Result<ResolveMediaResult>> {
  const parsed = sessionsResolveMediaInput.safeParse(args);
  if (!parsed.success) return { ok: false, code: 'invalid-args', message: parsed.error.message };
  try {
    const session = await deps.sessionStore.getById(parsed.data.sessionId);
    if (!session) return { ok: true, data: { error: { code: 'not_found', reason: 'Session not found' } } };
    return { ok: true, data: await deps.resolveMedia(parsed.data) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: true, data: { error: { code: 'load_failed', reason } } };
  }
}
