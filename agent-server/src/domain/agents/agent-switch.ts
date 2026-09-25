// input:  template-loader (getAgent) + config (getDefaultAgent/setDefaultAgent/clearChannelAgent/
//         resolveBackendForChannel) + profile-manager (resolveProfileConfig) + profile-switch
//         (decideProfileSwitch/channelHasHistory) + session-registry-repo (record sync)
// output: switchChannelAgent / clearChannelAgentSelection — the composed "switch the agent for a
//         channel/session" rule used by the `!agent` command AND the Web UI, so the rule has ONE
//         source of truth.
// pos:    domain/agents — the environment twin of profile-switch.ts. An agent decides the
//         conversation's prompt, tools, skills and rules; a profile decides its model. The two are
//         independent axes, so switching an agent writes the agent map and nothing else — but they
//         meet at the backend, because an agent that pins a profile pins that profile's backend,
//         and a live conversation can no more move across backends this way than through `!profile`.

import { sessionStore } from '@store/session-registry-repo.js';
import {
  clearChannelAgent, getActiveProfile, resolveBackendForChannel, setDefaultAgent,
  setSelectionDefaultAgent,
} from './config.js';
import { resolveProfileConfig } from './profile-manager.js';
import { channelHasHistory, decideProfileSwitch } from './profile-switch.js';
// The template loader, not the `@domain/threads` barrel: the barrel re-exports prompt-builder,
// which imports this domain back, and the cycle would be real at module-init time.
import { getAgent } from '../threads/template-loader.js';

export type SwitchAgentFailure = 'unknown-agent' | 'cross-backend-live-session';

export interface SwitchAgentSuccess {
  ok: true;
  /** The agent the channel now runs. */
  agentName: string;
  /** The profile that agent will actually run under — its own when it pins one, otherwise the
   *  channel's. FOR DISPLAY ONLY: the run path re-resolves it every turn, and this rule never
   *  writes `channelProfiles` (a pinned profile is already an override there). */
  effectiveProfile: string;
  /** True when the switch moved to a different backend (only possible on a fresh session). */
  backendChanged: boolean;
}

export interface SwitchAgentRefusal {
  ok: false;
  reason: SwitchAgentFailure;
  /** The channel's effective backend before the switch; absent when the agent was unknown. */
  currentBackend?: string;
  /** The backend the agent would have run on; absent when the agent was unknown. */
  targetBackend?: string;
}

export type SwitchAgentResult = SwitchAgentSuccess | SwitchAgentRefusal;

/**
 * The backend an agent runs on for a given channel: its own profile's when it pins one, else the
 * channel's — an `__active__` agent follows whatever the channel already resolves to, so it can
 * never move the backend by itself.
 */
function targetBackendOf(agentProfile: string, currentBackend: string): string {
  if (agentProfile === '__active__') return currentBackend;
  try {
    return resolveProfileConfig(agentProfile).backend;
  } catch {
    // A pinned profile that no longer exists cannot state a backend; the channel's own answer is
    // the honest one, and the run path reports the bad name when the turn opens.
    return currentBackend;
  }
}

/**
 * Switch the agent for a channel/session under the shared switch rule.
 *
 * Takes effect on the NEXT turn, like `!model`: the EngineSpec changes identity, so `SessionEngines`
 * restarts the process with `--resume` and the conversation keeps its history under the new prompt
 * and tool surface. Nothing is reset.
 *
 * The cross-backend refusal is {@link decideProfileSwitch}, unchanged — an agent that pins a
 * profile on the other backend is a backend move wearing a different hat, and a live conversation
 * cannot be resumed there.
 */
export async function switchChannelAgent(opts: { channel: string; name: string }): Promise<SwitchAgentResult> {
  const { channel, name } = opts;
  const agent = getAgent(name);
  if (!agent) return { ok: false, reason: 'unknown-agent' };

  const currentBackend = resolveBackendForChannel(channel);
  const targetBackend = targetBackendOf(agent.profile, currentBackend);
  const decision = decideProfileSwitch({
    currentBackend, targetBackend, hasHistory: await channelHasHistory(channel),
  });
  if (!decision.allowed) {
    return { ok: false, reason: 'cross-backend-live-session', currentBackend, targetBackend };
  }

  setDefaultAgent(name, channel);
  seedNextConversation(channel, name);
  await syncSessionAgent(channel, name);

  return {
    ok: true,
    agentName: name,
    effectiveProfile: agent.profile === '__active__' ? resolveChannelProfileName(channel) : agent.profile,
    backendChanged: decision.backendChanged,
  };
}

/** Drop the channel's agent selection: it follows the global default again, from the next turn. */
export async function clearChannelAgentSelection(channel: string): Promise<void> {
  clearChannelAgent(channel);
  seedNextConversation(channel, null);
  await syncSessionAgent(channel, null);
}

/** A pick made in the app says how the user wants to work, so the NEXT new conversation opens in
 *  the same environment. Direct (`web:`) channels only, for the reason `applyChannelSelection`
 *  gives: an `!agent` in some Slack thread is a tool for that thread. */
function seedNextConversation(channel: string, agentName: string | null): void {
  if (channel.startsWith('web:')) setSelectionDefaultAgent(agentName);
}

/** Keep the session-registry record in lock-step (best-effort), so the Web session list and
 *  `!resume` report the agent the channel is on. The channel map is the runtime source of truth;
 *  a failure here costs a label, not the switch. */
async function syncSessionAgent(channel: string, agentName: string | null): Promise<void> {
  try {
    const sessionName = await sessionStore.getActiveSessionName(channel);
    if (sessionName) await sessionStore.updateSession(sessionName, { agentName });
  } catch {
    // non-fatal — see above
  }
}

/** The profile name an `__active__` agent displays: whatever the channel itself resolves to. */
function resolveChannelProfileName(channel: string): string {
  try {
    return resolveProfileConfig(getActiveProfile(channel)).name;
  } catch {
    // No profile resolvable at all (profiles.json unreadable) — say what the agent declares rather
    // than inventing a name the run would not use.
    return '__active__';
  }
}
