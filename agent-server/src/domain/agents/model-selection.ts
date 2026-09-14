import type { Backend } from '../../agent-adapter/types.js';
import { readGatewayYaml } from '@core/gateway-generator.js';
import { GATEWAY_CONFIG_PATH } from '../pi-providers/gateway-route-store.js';
import { effectiveProfile, resolveRunConfig } from '../runs/config-resolver.js';
import type { ChannelOverride } from './agent-state.js';
import {
  clearChannelOverride, resolveBackendForChannel, setChannelOverride, setSelectionDefault,
} from './config.js';
import {
  findProfileForProvider, isValidThinkingLevel, resolveProfileConfig, THINKING_LEVELS_BY_BACKEND,
} from './profile-manager.js';
import { switchChannelProfile } from './profile-switch.js';

/**
 * One channel's model selection, written in one place.
 *
 * The product rule this module implements: **the profile stays the base**. It owns the backend, the
 * gateway route, extraEnv/extraOption and the fallback chain; a selection layers a model, a PI
 * provider and a thinking level on top of it (see `effectiveProfile`). Everything that decides
 * whether a change is allowed lives here, so the Web composer, `!model` and any future surface
 * reach identical answers — the UI's greying-out is a preview of this function, never a second rule.
 */

/** A field left `undefined` is untouched; `null` clears it; a string sets it. */
export interface SelectionPatch {
  model?: string | null;
  provider?: string | null;
  thinking?: string | null;
  mode?: string | null;
}

export interface ApplySelectionRequest extends SelectionPatch {
  channel: string;
  /** Injected in tests so the route check does not depend on the host's ~/.aistatus/gateway.yaml. */
  readGateway?: () => ReturnType<typeof readGatewayYaml>;
  /** Switch the channel to this profile first. Doing both in one call is what "pick a model that
   *  belongs to another profile" compiles down to. */
  profileName?: string;
}

export type SelectionFailure =
  | 'unknown-profile'
  | 'cross-backend-live-session'
  | 'invalid-thinking'
  | 'provider-not-supported'
  | 'invalid-mode';

/** What the channel will run on its next turn, after the change. */
export interface ChannelSelection {
  profileName: string;
  backend: Backend;
  /** Effective values — the profile's own, unless the selection overrode them. */
  model: string;
  provider: string | null;
  thinking: string | null;
  /** The gateway route the next turn bills to. */
  mode: string;
  /** Which of the effective values came from the selection rather than the profile. */
  override: ChannelOverride | null;
}

/**
 * The outcome, shaped like {@link SwitchProfileResult}: one flat record rather than a discriminated
 * union, because this package compiles with `strictNullChecks: false`, where a `ok: true | false`
 * discriminant does not narrow.
 *
 * The selection fields are always the channel's CURRENT ones — the new selection when the change
 * landed, the untouched one when it was refused. A caller that shows the result therefore shows the
 * truth either way, with no second read.
 */
export interface ApplySelectionResult extends ChannelSelection {
  ok: boolean;
  backendChanged: boolean;
  /** Present only when `ok` is false. */
  reason?: SelectionFailure;
  /** Present for 'cross-backend-live-session', so the caller can name both sides. */
  currentBackend?: string;
  targetBackend?: string;
  /** Present for 'invalid-thinking' and 'invalid-mode': what the backend or endpoint does accept. */
  allowed?: readonly string[];
}

const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** The gateway endpoint a profile's turns leave through: the provider for PI, the one Anthropic
 *  endpoint for claude — the same rule `gateway-generator` writes the file with. */
const CLAUDE_ENDPOINT = 'anthropic';

/**
 * The routes gateway.yaml declares for one endpoint, or an empty list when the file cannot be read.
 *
 * A route that the gateway does not declare answers 404 at turn time, which reads as the agent
 * dying, so this one IS checked — but only when the file could actually be read. Injected so the
 * rule stays testable on a host with no gateway.yaml.
 */
function declaredModes(endpoint: string, read = () => readGatewayYaml(GATEWAY_CONFIG_PATH)): string[] {
  const parsed = read();
  const modes = parsed?.endpoints?.[endpoint];
  return modes ? Object.keys(modes) : [];
}

/** The backend the request is validated against: the named profile's, or the channel's own when the
 *  request keeps the profile it has. null means the named profile does not exist. */
function targetBackend(request: ApplySelectionRequest): Backend | null {
  if (!request.profileName) return resolveBackendForChannel(request.channel);
  try {
    return resolveProfileConfig(request.profileName).backend;
  } catch {
    return null;
  }
}

/** A refusal: the reason, plus the selection the channel still has. */
function refuse(channel: string, reason: SelectionFailure): ApplySelectionResult {
  return { ...readChannelSelection(channel), ok: false, backendChanged: false, reason };
}

/** The channel's current selection, with no change applied. */
export function readChannelSelection(channel: string): ChannelSelection {
  const config = resolveRunConfig({ channel });
  const profile = effectiveProfile(config);
  return {
    profileName: config.profileName,
    backend: profile.backend,
    model: profile.model,
    provider: profile.provider,
    thinking: profile.thinking,
    mode: profile.mode,
    override: config.override,
  };
}

/**
 * Apply a selection to a channel.
 *
 * Order of operations, and why:
 *  1. Everything is validated against the backend the request is HEADED for (the named profile's,
 *     else the channel's), BEFORE anything is written — a request that fails must leave the channel
 *     exactly as it was, not half-switched.
 *  2. An explicit `profileName` switches first, under the shared cross-backend rule
 *     (`switchChannelProfile`). Choosing a profile means "run this profile", so its existing
 *     overrides are dropped — anything the same call still wants is re-applied in step 4.
 *  3. A PI provider the channel's profile does not use is looked up among the profiles: if the home
 *     has one for that provider, the channel moves there instead of carrying a provider override,
 *     so the route, env and fallback chain stay the ones the user configured for that provider.
 *  4. The remaining fields are patched onto the channel's override.
 */
export async function applyChannelSelection(request: ApplySelectionRequest): Promise<ApplySelectionResult> {
  const { channel } = request;
  let backendChanged = false;

  // Validate against the backend the request is HEADED for, before anything is written: a request
  // that names both a profile and a level the new backend rejects must fail whole, not leave the
  // channel switched.
  const target = targetBackend(request);
  if (!target) return refuse(channel, 'unknown-profile');
  if (request.thinking && !isValidThinkingLevel(target, request.thinking)) {
    return { ...refuse(channel, 'invalid-thinking'), allowed: THINKING_LEVELS_BY_BACKEND[target] };
  }
  if (request.provider && (target !== 'pi' || !PROVIDER_NAME_RE.test(request.provider))) {
    return refuse(channel, 'provider-not-supported');
  }
  if (request.mode) {
    // The endpoint the route must belong to: the provider this same request selects, else the one
    // the channel's profile already leaves through.
    const endpoint = target === 'claude'
      ? CLAUDE_ENDPOINT
      : request.provider ?? readChannelSelection(channel).provider ?? '';
    const modes = declaredModes(endpoint, request.readGateway);
    // No declared routes means gateway.yaml could not be read — the run falls back to a direct
    // connection anyway, so a route cannot be checked and is not refused.
    if (modes.length > 0 && !modes.includes(request.mode)) {
      return { ...refuse(channel, 'invalid-mode'), allowed: modes };
    }
  }

  if (request.profileName) {
    const switched = await switchChannelProfile({ channel, name: request.profileName });
    if (!switched.ok) {
      return switched.reason === 'unknown-profile'
        ? refuse(channel, 'unknown-profile')
        : {
          ...refuse(channel, 'cross-backend-live-session'),
          currentBackend: switched.currentBackend,
          targetBackend: switched.targetBackend,
        };
    }
    backendChanged = switched.backendChanged;
    clearChannelOverride(channel);
  }

  const patch: SelectionPatch = { model: request.model, thinking: request.thinking, mode: request.mode };

  if (request.provider) {
    // Compared against the PROFILE's own provider, never the effective one: a provider that is
    // only in force because an override carries it still needs that override. Reading the
    // effective value here would clear it on the next pick from the same provider and quietly
    // send the turn back to the profile's endpoint — the wrong gateway, with the wrong protocol.
    const base = resolveRunConfig({ channel }).profile;
    if (request.provider === base.provider) {
      // The profile already routes there; there is nothing left for an override to say.
      patch.provider = null;
    } else {
      // The route belongs to the endpoint being left behind; `effectiveProfile` re-derives it for
      // the new provider, so carrying the old one would only be a stale 404 waiting to happen.
      if (request.mode === undefined) patch.mode = null;
      const sibling = !request.profileName ? findProfileForProvider('pi', request.provider) : null;
      if (sibling) {
        const switched = await switchChannelProfile({ channel, name: sibling.name });
        // Same backend as the channel's current one, so the rule cannot refuse — but if it ever
        // did, the provider override below is still a correct (if less configured) answer.
        if (switched.ok) {
          backendChanged = backendChanged || switched.backendChanged;
          clearChannelOverride(channel);
          patch.provider = null;
        } else {
          patch.provider = request.provider;
        }
      } else {
        patch.provider = request.provider;
      }
    }
  } else if (request.provider === null) {
    patch.provider = null;
  }

  setChannelOverride(channel, patch);
  const selection = readChannelSelection(channel);
  // What the next brand-new conversation starts on. A pick made in the app is a statement about how
  // the user wants to work, not about this one session, so it outlives the session that made it —
  // and it always carries the profile it was made on, so the seed is a complete engine rather than
  // a set of overrides with no base to hang on.
  //
  // Only direct (`web:`) channels seed it. A platform channel's profile is chosen for that channel;
  // an `!thinking` in Slack has no business deciding what the desktop composer opens on.
  if (channel.startsWith('web:')) {
    setSelectionDefault({ profileName: selection.profileName, ...(selection.override ?? {}) });
  }
  return { ok: true, backendChanged, ...selection };
}
