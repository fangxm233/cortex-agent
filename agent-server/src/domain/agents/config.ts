import { getDefaultProfileName, resolveProfileConfig } from './profile-manager.js';
import {
  loadAgentState, saveAgentState,
  type AgentState, type ChannelOverride, type SelectionDefault,
} from './agent-state.js';
import type { Backend } from '../../agent-adapter/types.js';

/** The host's selection state. The one copy in memory, mirrored to agent-state.json on every change. */
let agentState: AgentState = loadAgentState();

function commit(next: AgentState): void {
  agentState = next;
  saveAgentState(agentState);
}

/** `map` with `key` set to `value`, or removed when `value` is null. */
function withEntry(map: Record<string, string>, key: string, value: string | null): Record<string, string> {
  const next = { ...map };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

export function getActiveProfile(channel?: string): string | null {
  const channelProfile = channel ? agentState.channelProfiles[channel] : undefined;
  if (channelProfile) return channelProfile;
  // '__active__' is the init default — resolve to profiles.json defaultProfile if still unset
  if (agentState.activeProfile === '__active__') {
    try { return getDefaultProfileName() || null; } catch { return null; }
  }
  return agentState.activeProfile;
}

const DEFAULT_CLAUDE_MODEL = 'opus';

/** The Claude model a channel with no selection of its own runs — the default profile's (D5) —
 *  else the stock alias when that profile is not a Claude one or cannot be read. */
export function defaultClaudeModel(): string {
  try {
    const profile = resolveProfileConfig(getActiveProfile());
    if (profile.backend === 'claude' && profile.model) return profile.model;
  } catch {
    // Unreadable profiles.json — the stock alias.
  }
  return DEFAULT_CLAUDE_MODEL;
}

/**
 * The backend a channel runs: its profile's, falling back to the default profile's.
 *
 * DEVIATION from plan D5, which has this "degenerate into reading the session record". That was
 * the right move while the session store keyed on `backend:channel` and the caller had to know the
 * backend to find the session at all — but the backend is no longer part of the key, so no session
 * lookup needs this any more. What is left are callers asking which backend a channel runs
 * (conversation ledger, rollback, compaction support), and for them the profile is the source of
 * truth, not a record of what some earlier session happened to use. Reading the record would also
 * make this async and ripple through fifteen synchronous call sites for a worse answer.
 *
 * Equivalent to `resolveRunBackend({ channel })` minus the session/override layers. The two cannot
 * be folded together here: `config-resolver` imports this module, so doing so would be an import
 * cycle.
 */
export function resolveBackendForChannel(channel?: string): Backend {
  const profileName = getActiveProfile(channel);
  if (profileName) {
    try {
      const cfg = resolveProfileConfig(profileName);
      if (cfg.backend) return cfg.backend;
    } catch {
      // Profile referenced by channelProfiles no longer exists — fall through to the default.
    }
  }
  // D5: with no daemon-wide backend left, the floor is the default profile's, and 'claude' only
  // when profiles.json itself cannot be read.
  try { return resolveProfileConfig(null).backend; } catch { return 'claude'; }
}

export function setActiveProfile(profileName: string | null, channel?: string): void {
  if (!channel) {
    commit({ ...agentState, activeProfile: profileName });
    return;
  }
  commit({ ...agentState, channelProfiles: withEntry(agentState.channelProfiles, channel, profileName) });
}

export function clearChannelProfile(channel: string): void {
  setActiveProfile(null, channel);
}

/** The channel's whole selection on top of its profile (model / provider / thinking). null when the
 *  channel runs its profile as declared, which is the normal case. */
export function getChannelOverride(channel?: string | null): ChannelOverride | null {
  if (!channel) return null;
  const override = agentState.channelOverrides[channel];
  return override && Object.keys(override).length > 0 ? { ...override } : null;
}

/**
 * Patch the channel's selection. A field set to `null` is cleared, a field left out is untouched,
 * and an override with nothing left in it is removed entirely (so "has a selection" stays a
 * truthful question to ask of the map).
 *
 * Takes effect on the next turn — a live turn already has its EngineSpec.
 */
export function setChannelOverride(channel: string, patch: Partial<Record<keyof ChannelOverride, string | null>>): void {
  const overrides = { ...agentState.channelOverrides };
  const next: ChannelOverride = { ...overrides[channel] };
  for (const [field, value] of Object.entries(patch) as [keyof ChannelOverride, string | null | undefined][]) {
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  if (Object.keys(next).length > 0) overrides[channel] = next;
  else delete overrides[channel];
  commit({ ...agentState, channelOverrides: overrides });
}

/**
 * Remember a composer's pick as the seed a brand-new conversation starts on.
 *
 * Written for direct (`web:`) channels only, by `applyChannelSelection` — never for a platform
 * channel, and never for `!model` / `!thinking`, which pass `seedDefault: false`. Those are
 * channel-scoped tools; letting one of them decide what the next Web session runs would be action
 * at a distance. Clearing back to the profile IS a choice and is remembered as one — the
 * seed then carries a profile and no overrides.
 */
export function setSelectionDefault(seed: SelectionDefault | null): void {
  // The agent is carried forward: the engine seed and the environment seed are two different picks,
  // and choosing a model is not a statement about which environment the next conversation opens in.
  // `setSelectionDefaultAgent` is the only writer of that half.
  const agentName = agentState.selectionDefault?.agentName;
  const next = seed && agentName && !seed.agentName ? { ...seed, agentName } : seed;
  commit({ ...agentState, selectionDefault: next ?? undefined });
}

/** Remember the composer's AGENT pick in the same seed, leaving the engine half alone. A null name
 *  records "the next conversation opens on the global default", which is a choice like any other. */
export function setSelectionDefaultAgent(agentName: string | null): void {
  const seed: SelectionDefault = { ...(agentState.selectionDefault ?? {}) };
  if (agentName) seed.agentName = agentName;
  else delete seed.agentName;
  commit({ ...agentState, selectionDefault: Object.keys(seed).length > 0 ? seed : undefined });
}

/** The seed for the next conversation, or null when nothing has been picked on this host yet. */
export function getSelectionDefault(): SelectionDefault | null {
  return agentState.selectionDefault ?? null;
}

/** Drop every override the channel carries — what an explicit "run this profile as declared"
 *  (a profile switch) means. */
export function clearChannelOverride(channel: string): void {
  if (!agentState.channelOverrides[channel]) return;
  const overrides = { ...agentState.channelOverrides };
  delete overrides[channel];
  commit({ ...agentState, channelOverrides: overrides });
}

/**
 * The agent a channel runs: its own selection, else the global default. Null when neither is set
 * and the caller's own fallback applies.
 *
 * The channel layer is what makes an agent a per-conversation choice rather than a daemon-wide
 * one — the same shape `getActiveProfile` has, and deliberately so: profile and agent are two
 * independent axes (which model vs which environment) and each has its own channel map.
 */
export function getDefaultAgent(channel?: string): string | null {
  const channelAgent = channel ? agentState.channelAgents[channel] : undefined;
  return channelAgent || agentState.defaultAgent;
}

/** Set the agent for one channel (`channel` given) or the global default (omitted). A null name
 *  clears: for a channel that means "follow the global default again", globally it means "no
 *  default agent at all". */
export function setDefaultAgent(name: string | null, channel?: string): void {
  if (!channel) {
    commit({ ...agentState, defaultAgent: name });
    return;
  }
  commit({ ...agentState, channelAgents: withEntry(agentState.channelAgents, channel, name) });
}

/** Drop the channel's agent selection — it follows the global default again. */
export function clearChannelAgent(channel: string): void {
  if (!agentState.channelAgents[channel]) return;
  setDefaultAgent(null, channel);
}

/** Every channel that has selected an agent of its own. */
export function getChannelAgents(): Record<string, string> {
  return { ...agentState.channelAgents };
}
