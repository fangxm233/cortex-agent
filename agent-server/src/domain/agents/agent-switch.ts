import { sessionStore } from '@store/session-registry-repo.js';
import { clearChannelAgent, setDefaultAgent, setSelectionDefaultAgent } from './config.js';
import { getEnvironment } from './environments/registry.js';

export type SwitchAgentFailure = 'unknown-agent';
export interface SwitchAgentSuccess { ok: true; agentName: string }
export interface SwitchAgentRefusal { ok: false; reason: SwitchAgentFailure }
export type SwitchAgentResult = SwitchAgentSuccess | SwitchAgentRefusal;

/** An environment pick changes prompt/tools, never the engine or its conversation history. */
export async function switchChannelAgent(opts: { channel: string; name: string }): Promise<SwitchAgentResult> {
  if (!getEnvironment(opts.name)) return { ok: false, reason: 'unknown-agent' };
  setDefaultAgent(opts.name, opts.channel);
  seedNextConversation(opts.channel, opts.name);
  await syncSessionAgent(opts.channel, opts.name);
  return { ok: true, agentName: opts.name };
}

export async function clearChannelAgentSelection(channel: string): Promise<void> {
  clearChannelAgent(channel);
  seedNextConversation(channel, null);
  await syncSessionAgent(channel, null);
}

function seedNextConversation(channel: string, agentName: string | null): void {
  if (channel.startsWith('web:')) setSelectionDefaultAgent(agentName);
}

/** The engine is not touched; a failed label sync does not discard the environment pick. */
async function syncSessionAgent(channel: string, agentName: string | null): Promise<void> {
  try {
    const session = await sessionStore.getById((await sessionStore.getBoundSessionId(channel)) ?? '');
    if (session) await sessionStore.updateSession(session.sessionId, { agentName });
  } catch { /* The channel's environment selection is already persisted. */ }
}
