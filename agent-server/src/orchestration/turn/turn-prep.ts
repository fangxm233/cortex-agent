import type { DownloadedFile, IncomingMessage } from '@platform/index.js';
import type { AttachmentFailure, InboundFiles } from '../routing/file-handler.js';
import { inboundAttachmentMeta } from '../attachments-store.js';
import { createLogger } from '@core/log.js';
import { resolveWorkspaceRelPath } from '@core/utils.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';
import { acquireBrowser, releaseBrowser, backendSupportsBrowser, BROWSER_DEVICE_SERVER } from '@platform/browser/managed-browser.js';
import { acquireDeviceBrowser, releaseDeviceBrowser } from '@domain/remote/device-browser.js';

const log = createLogger('turn-prep');

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

/**
 * A browser-enabled session holds the shared Chrome for the duration of its turn. Acquiring outside
 * the adapter keeps the spawn path synchronous and gives us one obvious place to pair with a
 * release. A browser that cannot start degrades the turn to "no browser tools" instead of failing
 * it — the session is still worth running.
 */
export async function acquireTurnBrowser(args: {
  backend: string;
  browser: { device: string } | null;
}): Promise<{ held: string | null; cdpEndpoint: string | null }> {
  const { backend, browser } = args;
  if (!browser) return { held: null, cdpEndpoint: null };
  if (!backendSupportsBrowser(backend)) {
    log.warn(`session opted into the browser but the ${backend} backend cannot use it — skipping`);
    return { held: null, cdpEndpoint: null };
  }
  const device = browser.device;
  try {
    // `server` is this host's own Chrome; anything else is a Chrome the device launches for us,
    // reachable only because the reverse channel maps its debugging port onto a local one. Both
    // hand back a plain http://127.0.0.1:<port>, so nothing downstream knows the difference.
    const cdpEndpoint = device === BROWSER_DEVICE_SERVER
      ? (await acquireBrowser()).cdpEndpoint
      : (await acquireDeviceBrowser(device)).cdpEndpoint;
    return { held: device, cdpEndpoint };
  } catch (error) {
    log.warn(`browser session requested on "${device}" but Chrome could not start: ${(error as Error).message}`);
    return { held: null, cdpEndpoint: null };
  }
}

/** Release whatever {@link acquireTurnBrowser} took. No-op when it took nothing. */
export function releaseTurnBrowser(held: string | null): void {
  if (held === BROWSER_DEVICE_SERVER) releaseBrowser();
  else if (held) releaseDeviceBrowser(held);
}
