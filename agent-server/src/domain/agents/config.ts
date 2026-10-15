import { getDefaultSelection, getDefaultSelectionForBackend } from './models.js';
import { loadAgentState, saveAgentState, type AgentState, type ModelMemory, type SelectionDefault } from './agent-state.js';
import { copySelection, modelKey, type EngineSelection } from './engine-selection.js';
import type { Backend } from '@core/types/agent-types.js';

let agentState: AgentState = loadAgentState();

/** Startup migrations run after static imports and may replace the persisted state. */
export function reloadAgentState(): void {
  agentState = loadAgentState();
}

function commit(next: AgentState): void {
  saveAgentState(next);
  agentState = next;
}

function withEntry<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...map };
  if (value !== null) next[key] = value;
  else delete next[key];
  return next;
}

export function getChannelSelection(channel?: string): EngineSelection | null {
  const selection = channel ? agentState.channelSelections[channel] : null;
  return selection ? copySelection(selection) : null;
}

export function setChannelSelection(channel: string, selection: EngineSelection | null): void {
  const next = selection ? copySelection(selection) : null;
  commit({ ...agentState, channelSelections: withEntry(agentState.channelSelections, channel, next) });
}

export function clearChannelSelection(channel: string): void {
  setChannelSelection(channel, null);
}

export function getModelMemory(): ModelMemory {
  return Object.fromEntries(Object.entries(agentState.modelMemory).map(([key, value]) => [key, { ...value }]));
}

export function rememberModelSelection(selection: EngineSelection): void {
  const memory = { thinking: selection.thinking, mode: selection.mode };
  commit({ ...agentState, modelMemory: withEntry(agentState.modelMemory, modelKey(selection), memory) });
}

export function defaultClaudeModel(): string {
  try { return getDefaultSelectionForBackend('claude')?.model ?? 'opus'; }
  catch { return 'opus'; }
}

export function resolveBackendForChannel(channel?: string): Backend {
  const selection = getChannelSelection(channel);
  if (selection) return selection.backend;
  try { return getDefaultSelection().backend; } catch { return 'claude'; }
}

/** Engine and agent picks are independent; a model pick preserves the environment seed. */
export function setSelectionDefault(seed: SelectionDefault | null): void {
  const agentName = seed?.agentName ?? agentState.selectionDefault?.agentName;
  const next = seed ? { ...copySelection(seed), ...(agentName ? { agentName } : {}) } : undefined;
  commit({ ...agentState, selectionDefault: next });
}

export function setSelectionDefaultAgent(agentName: string | null): void {
  const seed: SelectionDefault = { ...(agentState.selectionDefault ?? getDefaultSelection()) };
  if (agentName) seed.agentName = agentName;
  else delete seed.agentName;
  commit({ ...agentState, selectionDefault: seed });
}

export function getSelectionDefault(): SelectionDefault | null {
  return agentState.selectionDefault ? { ...agentState.selectionDefault } : null;
}

export function getDefaultAgent(channel?: string): string | null {
  return (channel && agentState.channelAgents[channel]) || agentState.defaultAgent;
}

export function setDefaultAgent(name: string | null, channel?: string): void {
  if (!channel) return commit({ ...agentState, defaultAgent: name });
  commit({ ...agentState, channelAgents: withEntry(agentState.channelAgents, channel, name) });
}

export function clearChannelAgent(channel: string): void {
  if (agentState.channelAgents[channel]) setDefaultAgent(null, channel);
}

export function getChannelAgents(): Record<string, string> {
  return { ...agentState.channelAgents };
}
