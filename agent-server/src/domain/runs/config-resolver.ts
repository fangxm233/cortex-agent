import type { Session } from '@store/session-registry-repo.js';
import { getChannelSelection } from '../agents/config.js';
import { configuredDefault } from '../agents/models.js';
import { resolveDaemonSelection } from '../agents/model-selection.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { resolveClaudeRoute, type ClaudeRoute } from '../connections/claude-route.js';

export interface RunSelectionQuery {
  channel?: string | null;
  session?: Partial<Pick<Session, 'selection' | 'backend' | 'sessionId' | 'backendSessionId'>> | null;
  selection?: EngineSelection | null;
}

function resolveQuery(query: RunSelectionQuery): { selection: EngineSelection; effective: EngineSelection } {
  const resolution = resolveDaemonSelection({
    request: query.selection,
    session: query.session?.selection,
    draft: getChannelSelection(query.channel ?? undefined),
  });
  if (resolution.ok === false) throw new Error(`No runnable model selection (${resolution.reason}); set a default model first`);
  const session = query.session;
  // Legacy records resume by sessionId; an explicit null is a history-free session.
  const resumeId = session?.backendSessionId === undefined ? session?.sessionId : session.backendSessionId;
  if (resumeId && session?.backend && resolution.selection.backend !== session.backend) {
    throw new Error(`Cannot resume ${session.backend} session on ${resolution.selection.backend} backend`);
  }
  return resolution;
}

/**
 * The selection a run uses: a selection the request carries > the recorded session > the channel's
 * draft > the configured default, completed by resolveSelection with its connection computed now.
 */
export function resolveRunSelection(query: RunSelectionQuery = {}): EngineSelection {
  return resolveQuery(query).effective;
}

/** What a new or resumed session records: the same layers, but the connection stays the user's
 *  choice (or null) instead of the one computed for this moment. */
export function resolveRecordedSelection(query: RunSelectionQuery = {}): EngineSelection {
  return resolveQuery(query).selection;
}

/** Startup and login can precede configuration; malformed configuration still throws. */
export function resolveConfiguredDefaultRun(): EngineSelection | null {
  return configuredDefault() ? resolveRunSelection() : null;
}

/** Resolve the route per run, never by changing the daemon's environment. A PI selection has no
 *  Claude route; its provider catalog is the PI adapter's. */
export function resolveRunRoute(selection: Pick<EngineSelection, 'backend' | 'connection'>): ClaudeRoute | undefined {
  return selection.backend === 'claude' ? resolveClaudeRoute(selection.connection) : undefined;
}

export function resolveRunBackend(query: RunSelectionQuery = {}): EngineSelection['backend'] {
  return resolveRunSelection(query).backend;
}
