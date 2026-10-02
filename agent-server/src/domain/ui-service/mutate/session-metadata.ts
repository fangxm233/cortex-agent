import { t } from '@core/i18n.js';
import { sessionsRenameInput, sessionsSetStarredInput } from '../session-metadata-schemas.js';
import type {
  Result, UiServiceDeps, SessionsRenameArgs, SessionsRenameReturn,
  SessionsSetStarredArgs, SessionsSetStarredReturn,
} from '../types.js';

export async function handleSetStarred(
  deps: UiServiceDeps,
  args: SessionsSetStarredArgs,
): Promise<Result<SessionsSetStarredReturn>> {
  const parsed = sessionsSetStarredInput.safeParse(args);
  if (!parsed.success) return { ok: false, code: 'invalid-args', message: parsed.error.message };
  if (!deps.sessionStore.setStarred) {
    return { ok: false, code: 'not-available', message: t('ui.session.metadataUnavailable') };
  }
  const { sessionId, starred } = parsed.data;
  const session = await deps.sessionStore.setStarred(sessionId, starred);
  if (!session) return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: sessionId }) };
  return { ok: true, data: { sessionId, starred } };
}

export async function handleRenameSession(
  deps: UiServiceDeps,
  args: SessionsRenameArgs,
): Promise<Result<SessionsRenameReturn>> {
  const parsed = sessionsRenameInput.safeParse(args);
  if (!parsed.success) return { ok: false, code: 'invalid-args', message: parsed.error.message };
  if (!deps.sessionStore.rename) {
    return { ok: false, code: 'not-available', message: t('ui.session.metadataUnavailable') };
  }
  const { sessionId, label } = parsed.data;
  const session = await deps.sessionStore.rename(sessionId, label);
  if (!session) return { ok: false, code: 'not-found', message: t('ui.session.notFound', { id: sessionId }) };
  return { ok: true, data: { sessionId, label } };
}
