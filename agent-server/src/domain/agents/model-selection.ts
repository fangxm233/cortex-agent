import { AsyncMutex } from '@core/async-mutex.js';
import { effectiveBackendSessionId, sessionStore, type Session } from '@store/session-registry-repo.js';
import type { CredentialInventory } from '../connections/inventory.js';
import type { CatalogSnapshot } from '../models/catalog.js';
import {
  getChannelSelection, getModelMemory, rememberModelSelection, setChannelSelection, setSelectionDefault,
} from './config.js';
import type { EngineSelection } from './engine-selection.js';
import { backendStartingPoint, configuredDefault, getDefaultSelection } from './models.js';
import {
  resolveSelection, type SelectionContext, type SelectionDefaults, type SelectionFailure, type SelectionResolution,
} from './resolve-selection.js';

export type { SelectionFailure } from './resolve-selection.js';

/** The daemon's defaults: models.json's default, and each backend's default or first favorite. */
export const daemonSelectionDefaults: SelectionDefaults = {
  selection: configuredDefault,
  forBackend: backendStartingPoint,
};

type SelectionLayers = Pick<SelectionContext, 'request' | 'session' | 'draft' | 'inventory' | 'catalog'>;

/** A resolution context over the daemon's own defaults and model memory. */
export function selectionContext(layers: SelectionLayers = {}): SelectionContext {
  return { ...layers, defaults: daemonSelectionDefaults, memory: getModelMemory };
}

/** Resolve against the daemon's state; the one entry point callers outside this module use. */
export function resolveDaemonSelection(
  layers: SelectionLayers, partial: Partial<EngineSelection> = {},
): SelectionResolution {
  return resolveSelection(selectionContext(layers), partial);
}

async function boundSession(channel: string): Promise<Session | null> {
  const sessionId = await sessionStore.getBoundSessionId(channel);
  return sessionId ? sessionStore.getById(sessionId) : null;
}

/** What a channel's next turn runs on: its session's selection once one exists, else its draft. */
export async function resolveChannelSelection(channel: string): Promise<EngineSelection> {
  const session = await boundSession(channel);
  const resolution = resolveDaemonSelection({ session: session?.selection, draft: getChannelSelection(channel) });
  if (resolution.ok === false) throw new Error(`No model is configured for this conversation (${resolution.reason})`);
  return resolution.effective;
}

/** The channel's draft, else the configured default — what a new conversation there starts on. */
export function readChannelSelection(channel: string): EngineSelection {
  return getChannelSelection(channel) ?? getDefaultSelection();
}

export interface ApplySelectionRequest extends Partial<EngineSelection> {
  channel: string;
  seedDefault?: boolean;
  /** The connections a pick is checked against; the daemon's own by default. */
  inventory?: CredentialInventory;
  /** The catalog a pick is checked against; the daemon's warm catalog by default. */
  catalog?: () => CatalogSnapshot;
}

export type ApplySelectionFailure = SelectionFailure | 'cross-backend-live-session';

export interface ApplySelectionResult extends EngineSelection {
  ok: boolean;
  backendChanged: boolean;
  reason?: ApplySelectionFailure;
  currentBackend?: string;
  targetBackend?: string;
  allowed?: readonly string[];
}

export type BackendSwitchDecision =
  | { allowed: true; backendChanged: boolean }
  | { allowed: false; reason: 'cross-backend-live-session' };

export function decideBackendSwitch(opts: {
  currentBackend: string; targetBackend: string; hasHistory: boolean;
}): BackendSwitchDecision {
  const backendChanged = opts.currentBackend !== opts.targetBackend;
  if (opts.hasHistory && backendChanged) return { allowed: false, reason: 'cross-backend-live-session' };
  return { allowed: true, backendChanged };
}

function refuse(
  current: EngineSelection | null, reason: ApplySelectionFailure, allowed?: readonly string[],
): ApplySelectionResult {
  const shown = current ?? { backend: 'claude', provider: null, model: '', thinking: null, connection: null };
  return { ...shown, ok: false, backendChanged: false, reason, ...(allowed ? { allowed } : {}) };
}

function requestedFields(request: ApplySelectionRequest): Partial<EngineSelection> {
  const { channel: _channel, seedDefault: _seed, inventory: _inventory, catalog: _catalog, ...partial } = request;
  return partial;
}

/** Serialize read/validate/write so simultaneous patches cannot overwrite a newer selection. */
const selectionWrites = new AsyncMutex();

export function applyChannelSelection(request: ApplySelectionRequest): Promise<ApplySelectionResult> {
  return selectionWrites.run(() => applySelection(request));
}

async function applySelection(request: ApplySelectionRequest): Promise<ApplySelectionResult> {
  const session = await boundSession(request.channel);
  const resolution = resolveDaemonSelection({
    session: session?.selection,
    draft: getChannelSelection(request.channel),
    inventory: request.inventory,
    catalog: request.catalog,
  }, requestedFields(request));
  if (resolution.ok === false) return refuse(resolution.base, resolution.reason, resolution.allowed);
  return persistSelection(request, resolution.base, resolution.selection, session);
}

async function persistSelection(
  request: ApplySelectionRequest, current: EngineSelection | null, target: EngineSelection, session: Session | null,
): Promise<ApplySelectionResult> {
  // Attach/resume clears channel turns, but the backend conversation still exists.
  const hasHistory = !!(session && effectiveBackendSessionId(session))
    || (await sessionStore.getTurns(request.channel)).length > 0;
  const currentBackend = session?.backend ?? current?.backend ?? target.backend;
  const decision = decideBackendSwitch({ currentBackend, targetBackend: target.backend, hasHistory });
  if (!decision.allowed) return {
    ...refuse(current, 'cross-backend-live-session'), currentBackend, targetBackend: target.backend,
  };
  // Session selection wins at run time: never acknowledge a pick if its journal write failed.
  if (session) await sessionStore.updateSession(session.sessionId, { backend: target.backend, selection: target });
  setChannelSelection(request.channel, target);
  rememberModelSelection(target);
  if (request.channel.startsWith('web:') && request.seedDefault !== false) setSelectionDefault(target);
  return { ...target, ok: true, backendChanged: decision.backendChanged };
}
