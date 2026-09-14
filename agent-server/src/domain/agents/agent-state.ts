import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import type { Backend } from '@core/types/agent-types.js';

const log = createLogger('agent-state');

const STATE_FILE = path.join(STORE_DIR, 'agent-state.json');
const LEGACY_FILE = path.join(STORE_DIR, 'mode.json');

/** A channel-scoped selection the user made on top of the channel's profile.
 *
 *  The profile stays the base (it owns the gateway route, extraEnv/extraOption and the fallback
 *  chain); these three fields are what a composer/`!model` can turn without editing profiles.json:
 *  the model, the PI provider that model belongs to, and the thinking level.
 *
 *  `backend` is deliberately NOT here: it comes from the profile and only the profile (D5), so the
 *  "a live conversation cannot change backend" rule has exactly one implementation
 *  (`decideProfileSwitch`). Selecting a model on another backend means switching profile. */
export interface ChannelOverride {
  model?: string;
  /** PI only — changes both the request protocol and the gateway endpoint, so `mode` is re-derived
   *  with it (see `effectiveProfile`). Never set for a claude profile. */
  provider?: string;
  /** Backend-native thinking level, validated against the channel's effective backend when set. */
  thinking?: string;
  /** Which gateway route of the profile's endpoint to bill — anthropic's `plan` (subscription) vs
   *  `api` (metered key). Only ever one of the routes gateway.yaml declares for that endpoint; a
   *  provider change re-derives it and drops this. */
  mode?: string;
}

/** The last engine choice made from a composer, profile included — what a brand-new conversation
 *  starts on, so "the next session picks up where the last one left off" needs no session to copy
 *  from. Written only by the composer's own write path: a channel-scoped `!model` in some Slack
 *  thread is a tool for that thread, not a statement about what the next Web session should run. */
export interface SelectionDefault extends ChannelOverride {
  profileName?: string;
}

export interface AgentState {
  /** Globally selected profile name. `'__active__'` is init's placeholder for "use the default". */
  activeProfile: string | null;
  /** Per-channel profile selection; beats `activeProfile` for that channel. */
  channelProfiles: Record<string, string>;
  /** Thread agent applied to plain messages when no agent is named. */
  defaultAgent: string | null;
  /** Per-channel knobs layered on top of the resolved profile. */
  channelOverrides: Record<string, ChannelOverride>;
  /** Seed for the next conversation's composer — see {@link SelectionDefault}. */
  selectionDefault?: SelectionDefault;

  // ── Legacy globals, still written until their last reader is gone ──────────
  // D5 moves backend/mode/model onto the profile: the run path resolves them per channel, and a
  // stored global can only disagree with the profile it shadows. The fields are carried through
  // migration so a rollback to the previous build finds the state it expects.
  /** @deprecated Read the resolved profile's backend. */
  backend?: Backend;
  /** @deprecated Read the resolved profile's mode. */
  claudeMode?: string;
  /** @deprecated Read the resolved profile's model. */
  claudeModel?: string;
}

function emptyState(): AgentState {
  return { activeProfile: null, channelProfiles: {}, defaultAgent: null, channelOverrides: {} };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'string' && entry) out[key] = entry;
  }
  return out;
}

const OVERRIDE_FIELDS = ['model', 'provider', 'thinking', 'mode'] as const;

function parseOverride(value: unknown): ChannelOverride {
  const raw = record(value);
  const override: ChannelOverride = {};
  for (const field of OVERRIDE_FIELDS) {
    const candidate = raw[field];
    if (typeof candidate === 'string' && candidate) override[field] = candidate;
  }
  return override;
}

function overrideMap(value: unknown): Record<string, ChannelOverride> {
  const out: Record<string, ChannelOverride> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const override = parseOverride(entry);
    // An entry with no usable field is not an override — dropping it keeps the map's presence
    // meaningful ("this channel selected something") for every reader.
    if (Object.keys(override).length > 0) out[key] = override;
  }
  return out;
}

function parseSelectionDefault(value: unknown): SelectionDefault | undefined {
  if (!value) return undefined;
  const seed: SelectionDefault = parseOverride(value);
  const profileName = record(value).profileName;
  if (typeof profileName === 'string' && profileName) seed.profileName = profileName;
  return Object.keys(seed).length > 0 ? seed : undefined;
}

/** Parse either file shape into one state. Unknown and malformed fields collapse to the empty
 *  value rather than throwing: a corrupt selection must not stop the daemon from starting, and
 *  every field has a defensible default. */
function parseState(raw: unknown): AgentState {
  const data = record(raw);
  const state = emptyState();
  if (typeof data.activeProfile === 'string' && data.activeProfile) state.activeProfile = data.activeProfile;
  state.channelProfiles = stringMap(data.channelProfiles);
  if (typeof data.defaultAgent === 'string' && data.defaultAgent) state.defaultAgent = data.defaultAgent;
  state.channelOverrides = overrideMap(data.channelOverrides);
  // Assigned only when there is one: an explicit `selectionDefault: undefined` key is still a key,
  // and every caller here compares whole states.
  const seed = parseSelectionDefault(data.selectionDefault);
  if (seed) state.selectionDefault = seed;
  if (data.backend === 'claude' || data.backend === 'pi') state.backend = data.backend;
  // mode.json wrote the Claude mode twice — `claudeMode`, and `mode` when the backend was claude.
  const legacyMode = typeof data.claudeMode === 'string' && data.claudeMode
    ? data.claudeMode
    : (data.backend === 'claude' && typeof data.mode === 'string' ? data.mode : undefined);
  if (legacyMode) state.claudeMode = legacyMode === 'plan' ? 'plan' : 'api';
  if (typeof data.claudeModel === 'string' && data.claudeModel) state.claudeModel = data.claudeModel;
  return state;
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Read the state, migrating `mode.json` on the boot that first finds it.
 *
 * The migration is a rename, not a delete: `mode.json.bak` is what the user gets back if this
 * build is rolled back, and it is also the evidence that the migration happened at all. An
 * existing `agent-state.json` always wins — a second migration could only overwrite newer state
 * with older.
 */
export function loadAgentState(): AgentState {
  if (existsSync(STATE_FILE)) return parseState(readJson(STATE_FILE));
  if (!existsSync(LEGACY_FILE)) return emptyState();
  const migrated = parseState(readJson(LEGACY_FILE));
  try {
    writeFileSync(STATE_FILE, JSON.stringify(migrated));
    renameSync(LEGACY_FILE, `${LEGACY_FILE}.bak`);
    log.info(`Migrated mode.json → agent-state.json (previous file kept as ${path.basename(LEGACY_FILE)}.bak)`);
  } catch (error) {
    // A read-only or full disk must not cost the user their selection for this run; the next boot
    // tries again, and until then the in-memory state is the migrated one either way.
    log.warn(`Could not persist the agent-state migration: ${(error as Error).message}`);
  }
  return migrated;
}

export function saveAgentState(state: AgentState): void {
  const data: Record<string, unknown> = {};
  if (state.activeProfile) data.activeProfile = state.activeProfile;
  if (Object.keys(state.channelProfiles).length > 0) data.channelProfiles = state.channelProfiles;
  if (state.defaultAgent) data.defaultAgent = state.defaultAgent;
  if (Object.keys(state.channelOverrides).length > 0) data.channelOverrides = state.channelOverrides;
  if (state.selectionDefault && Object.keys(state.selectionDefault).length > 0) {
    data.selectionDefault = state.selectionDefault;
  }
  if (state.backend) data.backend = state.backend;
  if (state.claudeMode) { data.claudeMode = state.claudeMode; data.mode = state.claudeMode; }
  if (state.claudeModel) data.claudeModel = state.claudeModel;
  writeFileSync(STATE_FILE, JSON.stringify(data));
}

/** Absolute paths, for the doctor check and the init writer. */
export const AGENT_STATE_FILE = STATE_FILE;
export const LEGACY_MODE_FILE = LEGACY_FILE;
