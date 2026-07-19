import type { ConfigProfileEntry } from '@cortex-agent/ui-contract';

// Profile-picker options, built from the REAL configured profiles (config.get → ConfigProfiles).
// Replaces the former hardcoded prototype list. `active` marks the session's current profile. The
// switch rule is shared with the backend (domain/agents/switchChannelProfile): a session that
// already has conversation history may only move BETWEEN same-backend profiles, so cross-backend
// options are `disabled` for a live session (the backend enforces the same rule as a backstop).

export interface ProfileOption {
  name: string;
  /** Sub-label: the profile's model · thinking (when set) · backend. */
  sub: string;
  active: boolean;
  /** The profile's backend (claude / codex / pi). */
  backend: string;
  /** True when this option can't be selected for the current (live) session — a cross-backend move. */
  disabled: boolean;
}

function backendOf(p: ConfigProfileEntry): string {
  return p.backend ?? 'claude';
}

// Sub-label shows the model, the thinking level when set, then the backend,
// e.g. "claude-opus-4-8 · high · claude" (thinking is dropped when the profile declares none).
function profileSub(p: ConfigProfileEntry): string {
  return [p.model, p.thinking, backendOf(p)].filter(Boolean).join(' · ');
}

/** The backend of the currently-active profile — the reference for the same-backend disable rule.
 *  Null when the active profile is not found in the list (unknown). */
export function currentBackendOf(profiles: ConfigProfileEntry[], active: string): string | null {
  const p = profiles.find((x) => x.name === active);
  return p ? backendOf(p) : null;
}

export function buildProfileOptions(
  profiles: ConfigProfileEntry[],
  active: string,
  opts: { currentBackend: string | null; hasHistory: boolean },
): ProfileOption[] {
  return profiles.map((p) => ({
    name: p.name,
    sub: profileSub(p),
    active: p.name === active,
    backend: backendOf(p),
    disabled: opts.hasHistory && opts.currentBackend !== null && backendOf(p) !== opts.currentBackend,
  }));
}
