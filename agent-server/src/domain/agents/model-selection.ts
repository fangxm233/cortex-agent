import { AsyncMutex } from '@core/async-mutex.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import { effectiveBackendSessionId, sessionStore, type Session } from '@store/session-registry-repo.js';
import { GATEWAY_CONFIG_PATH } from '../pi-providers/gateway-route-store.js';
import {
  getChannelSelection, getModelMemory, rememberModelSelection, setChannelSelection, setSelectionDefault,
} from './config.js';
import {
  isValidThinkingLevel, modelKey, THINKING_LEVELS_BY_BACKEND,
  type EngineSelection, type ModelRef,
} from './engine-selection.js';
import { firstModelRoute, getDefaultSelection, getDefaultSelectionForBackend } from './models.js';

export interface ApplySelectionRequest extends Partial<EngineSelection> {
  channel: string;
  seedDefault?: boolean;
  readGateway?: () => ReturnType<typeof readGatewayYaml>;
}

export type SelectionFailure = 'cross-backend-live-session' | 'invalid-thinking'
  | 'provider-not-supported' | 'invalid-mode' | 'invalid-model' | 'no-model-for-backend';

export interface ApplySelectionResult extends EngineSelection {
  ok: boolean;
  backendChanged: boolean;
  reason?: SelectionFailure;
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

export function readChannelSelection(channel: string): EngineSelection {
  return getChannelSelection(channel) ?? getDefaultSelection();
}

function refuse(current: EngineSelection, reason: SelectionFailure, allowed?: readonly string[]): ApplySelectionResult {
  return { ...current, ok: false, backendChanged: false, reason, ...(allowed ? { allowed } : {}) };
}

/** A complete identity needs no favorite. */
function targetRef(request: ApplySelectionRequest, current: EngineSelection): ModelRef | null {
  const backend = request.backend ?? current.backend;
  const changingBackend = backend !== current.backend;
  const base = changingBackend ? getDefaultSelectionForBackend(backend) : current;
  const model = request.model !== undefined ? request.model : base?.model;
  const provider = request.provider !== undefined ? request.provider : (backend === 'claude' ? null : base?.provider);
  if (model === undefined) return null;
  return { backend, provider: provider ?? null, model };
}

function mergeSelection(request: ApplySelectionRequest, current: EngineSelection, ref: ModelRef): EngineSelection {
  const changed = modelKey(ref) !== modelKey(current);
  const memory = getModelMemory()[modelKey(ref)];
  const settings = changed ? (memory ?? { thinking: null, mode: firstModelRoute(ref, request.readGateway) }) : current;
  return {
    ...ref,
    thinking: request.thinking !== undefined ? request.thinking : settings.thinking,
    mode: request.mode !== undefined ? request.mode : settings.mode,
  };
}

function targetSelection(request: ApplySelectionRequest, current: EngineSelection): EngineSelection | null {
  // A backend pick selects its complete default, not just its model identity.
  if (request.backend !== undefined && request.model === undefined && request.provider === undefined) {
    const defaults = getDefaultSelectionForBackend(request.backend);
    return defaults ? mergeSelection(request, defaults, defaults) : null;
  }
  const ref = targetRef(request, current);
  return ref ? mergeSelection(request, current, ref) : null;
}

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function invalidIdentity(selection: EngineSelection): SelectionFailure | null {
  if (typeof selection.model !== 'string' || !selection.model.trim()) return 'invalid-model';
  const validProvider = selection.backend === 'claude' ? selection.provider === null
    : selection.backend === 'pi' && typeof selection.provider === 'string' && SAFE_NAME.test(selection.provider);
  return validProvider ? null : 'provider-not-supported';
}

function validateTarget(
  request: ApplySelectionRequest, current: EngineSelection, target: EngineSelection,
): ApplySelectionResult | null {
  const identityFailure = invalidIdentity(target);
  if (identityFailure) return refuse(current, identityFailure);
  if (target.thinking !== null && !isValidThinkingLevel(target.backend, target.thinking)) {
    return refuse(current, 'invalid-thinking', THINKING_LEVELS_BY_BACKEND[target.backend]);
  }
  return validateRoute(request, current, target);
}

function validateRoute(
  request: ApplySelectionRequest, current: EngineSelection, target: EngineSelection,
): ApplySelectionResult | null {
  const gateway = (request.readGateway ?? (() => readGatewayYaml(GATEWAY_CONFIG_PATH)))();
  const endpoint = target.backend === 'claude' ? 'anthropic' : target.provider!;
  const modes = Object.keys(gateway?.endpoints?.[endpoint] ?? {});
  const validName = typeof target.mode === 'string' && SAFE_NAME.test(target.mode);
  if (!validName || (gateway && !modes.includes(target.mode))) return refuse(current, 'invalid-mode', modes);
  return null;
}

/** Serialize read/validate/write so simultaneous patches cannot overwrite a newer selection. */
const selectionWrites = new AsyncMutex();

export function applyChannelSelection(request: ApplySelectionRequest): Promise<ApplySelectionResult> {
  return selectionWrites.run(() => applySelection(request));
}

async function applySelection(request: ApplySelectionRequest): Promise<ApplySelectionResult> {
  const sessionId = await sessionStore.getBoundSessionId(request.channel);
  const session = sessionId ? await sessionStore.getById(sessionId) : null;
  const current = session?.selection ?? readChannelSelection(request.channel);
  const target = targetSelection(request, current);
  if (!target) return refuse(current, 'no-model-for-backend');
  const invalid = validateTarget(request, current, target);
  if (invalid) return invalid;
  return persistSelection(request, current, target, session);
}

async function persistSelection(
  request: ApplySelectionRequest, current: EngineSelection, target: EngineSelection, session: Session | null,
): Promise<ApplySelectionResult> {
  // Attach/resume clears channel turns, but the backend conversation still exists.
  const hasHistory = !!(session && effectiveBackendSessionId(session))
    || (await sessionStore.getTurns(request.channel)).length > 0;
  const currentBackend = session?.backend ?? current.backend;
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
