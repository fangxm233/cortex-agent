import type { DownloadedFile, IncomingMessage } from '@platform/index.js';
import type { AttachmentFailure, InboundFiles } from '../routing/file-handler.js';
import { inboundAttachmentMeta } from '../attachments-store.js';
import { resolveWorkspaceRelPath } from '@core/paths.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';

export interface SessionUseLease {
  session: Session;
  release: () => void;
}

/** Take the session's use lease, or null when the record is gone / pending deletion. The lease is
 *  what stops retention from deleting a session out from under a turn that is still opening. */
export async function acquireSessionUseLease(sessionId: string): Promise<SessionUseLease | null> {
  const session = await sessionStore.getById(sessionId);
  if (!session) return null;
  const release = await acquireSessionUse(sessionId);
  if (!release) return null;
  return { session, release };
}

export interface TurnFiles {
  /** Everything the backend is told about: platform downloads first, then web uploads. */
  files: DownloadedFile[];
  /** Transcript cards for the platform downloads only — a web upload already has its own card,
   *  minted by the upload route and carried on the message. */
  platformAttachments: IncomingMessage['webAttachments'];
  /** Attachments the platform would not hand over (reported in the prompt, not swallowed). */
  failures: AttachmentFailure[];
}

/**
 * The files one turn carries: what the platform had to download, plus the web upload's attachments
 * which are already on disk.
 *
 * The `path` field from upload is the UI-relative `workspace/attachments/...` alias for
 * WORKSPACE_DIR's contents; resolveWorkspaceRelPath maps it to the real absolute path under
 * WORKSPACE_DIR (= <DATA_DIR>/tmp). A malformed/escaping path resolves to null and is dropped, so a
 * broken path is never handed to the agent as a bogus absolute file.
 *
 * A platform download also gets a transcript card here, so an image sent from Slack or Feishu is
 * visible when the same session is opened in the Web UI — previously only web uploads were, and a
 * Feishu-sent picture simply vanished from the transcript.
 */
export async function collectTurnFiles(
  message: IncomingMessage,
  loadPlatformFiles: () => Promise<InboundFiles>,
): Promise<TurnFiles> {
  const { files: downloadedFiles, failures } = await loadPlatformFiles();
  const metas = await Promise.all(downloadedFiles.map(inboundAttachmentMeta));
  const platformAttachments = metas.filter((meta): meta is NonNullable<typeof meta> => meta !== null);
  return {
    files: [
      ...downloadedFiles,
      ...(message.webAttachments ?? []).flatMap((a) => {
        const localPath = resolveWorkspaceRelPath(a.path);
        return localPath ? [{ localPath, mimetype: a.mimeType, name: a.name }] : [];
      }),
    ],
    platformAttachments: platformAttachments.length > 0 ? platformAttachments : undefined,
    failures,
  };
}
