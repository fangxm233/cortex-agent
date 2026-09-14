// input:  a run's profile name and channel
// output: the ResolvedProfileConfig a continuation run spawns under
// pos:    orchestration — shared by the surfaces that open a follow-up run (ask-user resume,
//         edit retry) so both keep the "open the execution record, then let the run reject an
//         unknown name" ordering.
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { ResolvedProfileConfig } from '@domain/agents/profile-manager.js';
import { resolveProfileConfig } from '@domain/agents/profile-manager.js';
import { resolveBackendForChannel } from '@domain/agents/index.js';
import { resolveRunConfig } from '@domain/runs/config-resolver.js';

/** Synthetic profile for an unknown configured name. Keeps the requested name so the run still
 *  rejects it (after the execution record has been opened), while its backend/mode mirror the
 *  channel's active backend. */
function fallbackRunProfile(profileName: string | null, channel: string): ResolvedProfileConfig {
  return {
    name: profileName ?? '',
    model: '',
    backend: resolveBackendForChannel(channel),
    mode: resolveRunConfig({ channel }).profile.mode,
    provider: null,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: null,
    maxOutputTokens: null, fallback: [],
  };
}

/** Resolve the profile a continuation run spawns, preserving the "open the execution record, then
 *  let the run reject an unknown name" ordering. */
export function resolveRunProfile(profileName: string | null, channel: string): ResolvedProfileConfig {
  try {
    return resolveProfileConfig(profileName);
  } catch {
    return fallbackRunProfile(profileName, channel);
  }
}
