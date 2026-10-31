import { modelsRepo } from '@store/models-repo.js';
import type { Session } from '@store/session-registry-repo.js';
import { getChannelSelection } from '../agents/config.js';
import { getDefaultSelection } from '../agents/models.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { resolveClaudeRoute, type ClaudeRoute } from '../connections/claude-route.js';

export interface RunSelectionQuery {
  channel?: string | null;
  session?: Partial<Pick<Session, 'selection' | 'backend' | 'sessionId' | 'backendSessionId'>> | null;
  selection?: EngineSelection | null;
}

/** Explicit request > recorded session > channel > configured default. No overlays. */
export function resolveRunSelection(query: RunSelectionQuery = {}): EngineSelection {
  const selection = query.selection ?? query.session?.selection
    ?? getChannelSelection(query.channel ?? undefined) ?? getDefaultSelection();
  const session = query.session;
  // Legacy records resume by sessionId; an explicit null is a history-free session.
  const resumeId = session?.backendSessionId === undefined ? session?.sessionId : session.backendSessionId;
  if (resumeId && session?.backend && selection.backend !== session.backend) {
    throw new Error(`Cannot resume ${session.backend} session on ${selection.backend} backend`);
  }
  return selection;
}

/** Startup and login can precede configuration; malformed configuration still throws. */
export function resolveConfiguredDefaultRun(): EngineSelection | null {
  if (!modelsRepo.readIfPresent()?.default) return null;
  return getDefaultSelection();
}

/** Resolve the route per run, never by changing the daemon's environment. A PI selection has no
 *  Claude route; its provider catalog is the PI adapter's. */
export function resolveRunRoute(selection: Pick<EngineSelection, 'backend' | 'connection'>): ClaudeRoute | undefined {
  return selection.backend === 'claude' ? resolveClaudeRoute(selection.connection) : undefined;
}

export function resolveRunBackend(query: RunSelectionQuery = {}): EngineSelection['backend'] {
  return resolveRunSelection(query).backend;
}
