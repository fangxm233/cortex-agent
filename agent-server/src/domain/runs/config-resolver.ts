import { modelsRepo } from '@store/models-repo.js';
import { getChannelSelection } from '../agents/config.js';
import { getDefaultSelection } from '../agents/models.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { resolveModeEnv, type ModeEnv } from './mode-env.js';
import type { RunRequest } from './request.js';

export interface RunSelectionQuery {
  channel?: string | null;
  session?: { selection?: EngineSelection | null } | null;
  selection?: EngineSelection | null;
}

/** Explicit request > recorded session > channel > configured default. No overlays. */
export function resolveRunSelection(query: RunSelectionQuery = {}): EngineSelection {
  return query.selection ?? query.session?.selection
    ?? getChannelSelection(query.channel ?? undefined) ?? getDefaultSelection();
}

/** Startup and login can precede configuration; malformed configuration still throws. */
export function resolveConfiguredDefaultRun(): EngineSelection | null {
  if (!modelsRepo.readIfPresent()?.default) return null;
  return getDefaultSelection();
}

/** Resolve the route per run, never by changing the daemon's environment. */
export function resolveRunRoute(
  selection: { mode?: EngineSelection['mode'] },
  context: { project?: string | null; trigger?: string | null } = {},
): ModeEnv {
  const metadata: Record<string, string> = {};
  if (context.project) metadata.project = context.project;
  if (context.trigger) metadata.trigger = context.trigger;
  return resolveModeEnv(selection.mode || 'api', Object.keys(metadata).length ? metadata : undefined);
}

export function requestRoute(
  request: { context: Pick<RunRequest['context'], 'project' | 'trigger' | 'routeTrigger'> },
  selection: { mode?: EngineSelection['mode'] },
): ModeEnv {
  const { project, trigger, routeTrigger } = request.context;
  return resolveRunRoute(selection, { project, trigger: routeTrigger ?? trigger });
}

export function resolveRunBackend(query: RunSelectionQuery = {}): EngineSelection['backend'] {
  return resolveRunSelection(query).backend;
}
