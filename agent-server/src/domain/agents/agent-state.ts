import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import type { Backend } from '@core/types/agent-types.js';

const log = createLogger('agent-state');

const STATE_FILE = path.join(STORE_DIR, 'agent-state.json');
const LEGACY_FILE = path.join(STORE_DIR, 'mode.json');

/** A channel-scoped override the user set with a command. Narrow on purpose: backend, provider,
 *  mode and thinking come from the profile and only the profile (D5); a model is the one knob
 *  worth turning without editing profiles.json, and `!backend` switches the profile instead. */
export interface ChannelOverride {
  model?: string;
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

function overrideMap(value: unknown): Record<string, ChannelOverride> {
  const out: Record<string, ChannelOverride> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const model = record(entry).model;
    if (typeof model === 'string' && model) out[key] = { model };
  }
  return out;
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
  if (state.backend) data.backend = state.backend;
  if (state.claudeMode) { data.claudeMode = state.claudeMode; data.mode = state.claudeMode; }
  if (state.claudeModel) data.claudeModel = state.claudeModel;
  writeFileSync(STATE_FILE, JSON.stringify(data));
}

/** Absolute paths, for the doctor check and the init writer. */
export const AGENT_STATE_FILE = STATE_FILE;
export const LEGACY_MODE_FILE = LEGACY_FILE;
