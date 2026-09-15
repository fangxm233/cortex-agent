// input:  the inbound message and the channel a turn is about to open on
// output: everything a caller must resolve BEFORE `openTurn` — the turn's files, its session
//         record + use lease, and the Chrome the session opted into
// pos:    orchestration/turn — the pre-turn half of what `agent-runner._executeReal` used to hold
//         inline. It lives here, next to the Turn, for one reason: `agent-runner.ts` is the
//         admission path (routing, injection, queueing) and the plan caps it at 300 lines. The
//         CALL SITES stay in `agent-runner` — find-or-create, lease and browser are still its
//         decisions — but the bodies are turn-scoped and are not needed anywhere else.
//         `resolveDefaultAgent` / `resolveSessionName` have no production caller left (request
//         assembly resolves the agent slot itself, and the Turn is handed its ids); both are kept
//         because `tests/orch/agent-runner.test.ts` and
//         `tests/orch/session-lifecycle-characterization.test.ts` pin their behaviour, and both are
//         re-exported from `agent-runner.ts` so those imports still resolve.

import type { DownloadedFile, IncomingMessage, PlatformAdapter } from '@platform/index.js';
import type { AttachmentFailure, InboundFiles } from '../routing/file-handler.js';
import { inboundAttachmentMeta } from '../attachments-store.js';
import { createLogger } from '@core/log.js';
import { resolveWorkspaceRelPath } from '@core/utils.js';
import { sessionStore, type Session } from '@store/session-registry-repo.js';
import { getActiveProfile, getDefaultAgent, resolveBackendForChannel } from '@domain/agents/index.js';
import { resolveProfileConfig } from '@domain/agents/profile-manager.js';
import { registerNamedSession } from '@domain/sessions/session-lifecycle.js';
import { acquireSessionUse } from '@domain/sessions/session-use.js';
import { getAgent } from '@domain/threads/index.js';
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

/** The session's backend decides whether a browser can be driven at all; the profile's
 *  `claudeBackend` decides whether it is the print adapter — the only one wired for it. */
function browserBackendSupported(channel: string, backend: string): boolean {
  let claudeBackend: string | null = null;
  try {
    claudeBackend = resolveProfileConfig(getActiveProfile(channel)).claudeBackend;
  } catch {
    // Unknown profile: fall back to the backend alone rather than refusing outright.
  }
  return backendSupportsBrowser(backend, claudeBackend);
}

/**
 * A browser-enabled session holds the shared Chrome for the duration of its turn. Acquiring outside
 * the adapter keeps the spawn path synchronous and gives us one obvious place to pair with a
 * release. A browser that cannot start degrades the turn to "no browser tools" instead of failing
 * it — the session is still worth running.
 */
export async function acquireTurnBrowser(args: {
  channel: string;
  backend: string;
  browser: { device: string } | null;
}): Promise<{ held: string | null; cdpEndpoint: string | null }> {
  const { channel, backend, browser } = args;
  if (!browser) return { held: null, cdpEndpoint: null };
  if (!browserBackendSupported(channel, backend)) {
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

export interface AgentConfig {
  effectiveMessage: string;
  profileForRun: string;
  defaultAgentName: string | null;
  claudeAgent: string | null;
  systemPrompt: string | null;
  outputStyle: string | null;
  tools: string | null;
  pluginDirs: string[] | null;
}

/** Exposed for unit testing. */
export function resolveDefaultAgent(agentMessage: string, channel?: string): AgentConfig {
  const defaultAgentName = getDefaultAgent();
  const defaultAgentDef = defaultAgentName ? getAgent(defaultAgentName) : null;
  const profileForRun = (defaultAgentDef && defaultAgentDef.profile !== '__active__')
    ? defaultAgentDef.profile
    : getActiveProfile(channel);
  let effectiveMessage = agentMessage;
  if (defaultAgentDef?.directive) {
    effectiveMessage = defaultAgentDef.directive + '\n\n' + agentMessage;
  }
  return {
    effectiveMessage, profileForRun, defaultAgentName,
    claudeAgent: defaultAgentDef?.claudeAgent || null,
    systemPrompt: defaultAgentDef?.systemPrompt || null,
    outputStyle: defaultAgentDef?.outputStyle || null,
    tools: defaultAgentDef?.tools || null,
    pluginDirs: defaultAgentDef?.pluginDirs || null,
  };
}

export async function resolveSessionName(sessionId: string | null, channel: string, userMessage: string, adapter: PlatformAdapter): Promise<string> {
  if (sessionId) {
    const existing = await sessionStore.lookupBySessionId(sessionId);
    if (existing) return existing;
    const channelProject = await adapter.resolveInboundProject(channel);
    return registerNamedSession(sessionStore, {
      sessionId,
      channel,
      backend: resolveBackendForChannel(channel),
      label: userMessage?.substring(0, 60),
      profileName: getActiveProfile(channel),
      projectId: channelProject ?? 'general',
    });
  }
  return sessionStore.generateSessionName();
}
