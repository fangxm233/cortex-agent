import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { copySelection, validateEngineSelection, type EngineSelection } from './engine-selection.js';

const STATE_FILE = path.join(STORE_DIR, 'agent-state.json');
export type SelectionDefault = EngineSelection & { agentName?: string };
export type ModelMemory = Record<string, { thinking: string | null; mode: string }>;

export interface AgentState {
  channelSelections: Record<string, EngineSelection>;
  modelMemory: ModelMemory;
  defaultAgent: string | null;
  channelAgents: Record<string, string>;
  selectionDefault?: SelectionDefault;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function parseSelection(value: unknown): EngineSelection | null {
  try {
    validateEngineSelection(value);
    return copySelection(value);
  } catch { return null; }
}

function parseMap<T>(value: unknown, parse: (entry: unknown) => T | null): Record<string, T> {
  const entries = Object.entries(record(value)).map(([key, entry]) => [key, parse(entry)] as const);
  return Object.fromEntries(entries.filter(([, entry]) => entry !== null));
}

function parseMemory(value: unknown): ModelMemory[string] | null {
  const raw = record(value);
  const validThinking = raw.thinking === null || (typeof raw.thinking === 'string' && !!raw.thinking);
  if (!validThinking || typeof raw.mode !== 'string' || !raw.mode) return null;
  return { thinking: raw.thinking as string | null, mode: raw.mode };
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parseState(value: unknown): AgentState {
  const raw = record(value);
  const state: AgentState = {
    channelSelections: parseMap(raw.channelSelections, parseSelection),
    modelMemory: parseMap(raw.modelMemory, parseMemory),
    defaultAgent: parseString(raw.defaultAgent),
    channelAgents: parseMap(raw.channelAgents, parseString),
  };
  const seed = parseSelection(raw.selectionDefault);
  if (seed) {
    state.selectionDefault = seed;
    const agentName = parseString(record(raw.selectionDefault).agentName);
    if (agentName) state.selectionDefault.agentName = agentName;
  }
  return state;
}

/** Migration owns legacy data. Runtime reads only concrete selections and never rewrites on read. */
export function loadAgentState(): AgentState {
  try { return parseState(JSON.parse(readFileSync(STATE_FILE, 'utf8'))); }
  catch { return parseState(null); }
}

/** Replace atomically so interruption cannot leave a truncated selection or model memory. */
export function saveAgentState(state: AgentState): void {
  const data: Record<string, unknown> = {};
  for (const field of ['channelSelections', 'modelMemory', 'channelAgents'] as const) {
    if (Object.keys(state[field]).length) data[field] = state[field];
  }
  if (state.defaultAgent) data.defaultAgent = state.defaultAgent;
  if (state.selectionDefault) data.selectionDefault = state.selectionDefault;
  const temporary = `${STATE_FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify(data));
  renameSync(temporary, STATE_FILE);
}
