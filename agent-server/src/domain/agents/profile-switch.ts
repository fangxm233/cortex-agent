// input:  profile-manager (resolveProfile/resolveProfileConfig) + config (resolveBackendForChannel/
//         setActiveProfile) + conversation-ledger-repo (history) + session-registry-repo (record sync)
// output: decideProfileSwitch (pure policy) + switchChannelProfile (composed switch used by
//         Slack/Feishu commands AND the Web UI, so the rule has ONE source of truth)
// pos:    domain/agents — the single "switch the active profile for a channel/session" rule.
//         Policy: a session that already has conversation history may only move BETWEEN
//         same-backend profiles (switching in place, no session reset); a fresh session (no
//         history) may switch to any profile freely. A same-backend switch never resets the
//         session — the agent runner re-resolves the profile per turn, so only the model changes.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { resolveBackendForChannel, setActiveProfile } from './config.js';
import { resolveProfile, resolveProfileConfig } from './profile-manager.js';

export type ProfileSwitchDecision =
  | { allowed: true; backendChanged: boolean }
  | { allowed: false; reason: 'cross-backend-live-session' };

/**
 * Pure switch policy shared by every surface (Slack / Feishu / Web).
 *
 * - No history (fresh session) → any switch is allowed, including across backends. `backendChanged`
 *   reports whether the backend moved (the caller may want it for messaging), but nothing is blocked.
 * - Has history (live conversation) → only a same-backend switch is allowed. A cross-backend switch
 *   is rejected because the running conversation cannot be resumed on a different backend; the user
 *   must start a new session to change backend.
 *
 * NOTE: `claudeBackend` (print vs tui) is deliberately NOT part of the identity — those share
 * `backend: 'claude'` and count as the same backend (product decision), so switching between a
 * print and a tui claude profile mid-conversation is allowed.
 */
export function decideProfileSwitch(opts: {
  currentBackend: string;
  targetBackend: string;
  hasHistory: boolean;
}): ProfileSwitchDecision {
  const backendChanged = opts.currentBackend !== opts.targetBackend;
  if (opts.hasHistory && backendChanged) {
    return { allowed: false, reason: 'cross-backend-live-session' };
  }
  return { allowed: true, backendChanged };
}

export type SwitchProfileFailure = 'unknown-profile' | 'cross-backend-live-session';

export interface SwitchProfileResult {
  ok: boolean;
  /** The requested profile name (echoed back). */
  name: string;
  /** The channel's effective backend before the switch (empty when the profile was unknown). */
  currentBackend: string;
  /** The target profile's backend (empty when the profile was unknown). */
  targetBackend: string;
  /** True when the switch moved to a different backend (only possible on a fresh session). */
  backendChanged: boolean;
  /** Present only when `ok` is false. */
  reason?: SwitchProfileFailure;
}

/** Does the channel's session already carry conversation history? A fresh (just-created) session has
 *  a ledger entry with zero turns; a live conversation has ≥1 turn. */
export async function channelHasHistory(channel: string): Promise<boolean> {
  const conv = await conversationLedger.getConversation(channel);
  return !!conv && conv.turns.length > 0;
}

/**
 * Switch the active profile for a channel/session under the shared rule. Validates the profile,
 * applies {@link decideProfileSwitch}, and on success sets the channel's active profile AND syncs the
 * session-registry record's `profileName` (so `!resume` and the Web session list reflect it). Never
 * resets the session — a same-backend switch keeps the conversation, the model changes on the next
 * turn. Returns a structured result; the caller maps it to a reply / tRPC error.
 */
export async function switchChannelProfile(opts: { channel: string; name: string }): Promise<SwitchProfileResult> {
  const { channel, name } = opts;

  let targetBackend: string;
  try {
    resolveProfile(name); // existence check — throws "Unknown profile: …"
    targetBackend = resolveProfileConfig(name).backend;
  } catch {
    return { ok: false, name, currentBackend: '', targetBackend: '', backendChanged: false, reason: 'unknown-profile' };
  }

  const currentBackend = resolveBackendForChannel(channel);
  const hasHistory = await channelHasHistory(channel);
  const decision = decideProfileSwitch({ currentBackend, targetBackend, hasHistory });

  if (!decision.allowed) {
    return { ok: false, name, currentBackend, targetBackend, backendChanged: true, reason: 'cross-backend-live-session' };
  }

  setActiveProfile(name, channel);

  // Keep the session-registry record's profileName in lock-step (best-effort). The active session is
  // keyed by (channel, effective backend); after the switch that backend is the target's backend.
  try {
    const sessionName = await sessionStore.getActiveSessionName(channel, resolveBackendForChannel(channel));
    if (sessionName) await sessionStore.updateSession(sessionName, { profileName: name });
  } catch {
    // record sync is non-fatal — the channel profile (the runtime source of truth) is already set
  }

  return { ok: true, name, currentBackend, targetBackend, backendChanged: decision.backendChanged };
}
