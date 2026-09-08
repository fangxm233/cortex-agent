// input:  a child's cwd, agent dir, model selection, tool allowlist, role prompt and extensions
// output: ChildSessionHandle: one nested in-memory PI SDK session, bound headless, disposable
// pos:    Builds the nested PI sessions the Agent tool runs subagents on
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as path from 'node:path';
import type { AgentSession, InlineExtension } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@core/log.js';
import { loadPiSdk, type PiSdkModule } from '@core/pi-sdk.js';

const log = createLogger('pi-subagent');

export interface ChildSessionRequest {
  cwd: string;
  /** PI agent dir whose auth.json and models.json the child authenticates and routes with. */
  agentDir: string;
  provider: string | null;
  model: string | null;
  /** Built-in tool names the child may use; undefined leaves PI's default set. */
  tools?: string[];
  /** Role prompt text appended to PI's system prompt. */
  appendSystemPrompt: string[];
  /** The only extensions the child loads; user extensions are skipped. */
  extensions: InlineExtension[];
}

export type ChildAgentSession = Pick<AgentSession, 'prompt' | 'subscribe' | 'abort'>;

export interface ChildSessionHandle {
  session: ChildAgentSession;
  dispose(): void;
}

export type ChildSessionFactory = (request: ChildSessionRequest) => Promise<ChildSessionHandle>;

function projectTrusted(sdk: PiSdkModule, cwd: string, agentDir: string): boolean {
  if (!sdk.hasTrustRequiringProjectResources(cwd)) return true;
  return new sdk.ProjectTrustStore(agentDir).get(cwd) === true;
}

/** PI's own CLI resolver, so a role's `provider/model` selection behaves as `--provider --model` did. */
function resolveModel(
  sdk: PiSdkModule,
  request: ChildSessionRequest,
  modelRuntime: Parameters<PiSdkModule['resolveCliModel']>[0]['modelRuntime'],
): ReturnType<PiSdkModule['resolveCliModel']>['model'] {
  if (!request.model) return undefined;
  const resolved = sdk.resolveCliModel({
    cliProvider: request.provider ?? undefined,
    cliModel: request.model,
    modelRuntime,
  });
  if (resolved.error) throw new Error(resolved.error);
  if (resolved.warning) log.warn(`PI subagent model resolution: ${resolved.warning}`);
  return resolved.model;
}

/**
 * One nested PI session for a subagent, in this process. It keeps no transcript (in-memory
 * session manager), loads only the extensions handed in, and runs headless: with no UI context
 * bound, PI's extension dialogs resolve as cancelled instead of waiting on a host.
 */
export async function createChildSession(request: ChildSessionRequest): Promise<ChildSessionHandle> {
  const sdk = await loadPiSdk();
  const settingsManager = sdk.SettingsManager.create(request.cwd, request.agentDir, {
    projectTrusted: projectTrusted(sdk, request.cwd, request.agentDir),
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(request.agentDir, 'auth.json'),
    modelsPath: path.join(request.agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  const services = await sdk.createAgentSessionServices({
    cwd: request.cwd,
    agentDir: request.agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true,
      extensionFactories: request.extensions,
      appendSystemPrompt: request.appendSystemPrompt,
    },
  });
  for (const diagnostic of services.diagnostics) {
    if (diagnostic.type === 'error') log.warn(`PI subagent session: ${diagnostic.message}`);
  }
  const created = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.inMemory(request.cwd),
    model: resolveModel(sdk, request, services.modelRuntime),
    tools: request.tools,
  });
  await created.session.bindExtensions({
    mode: 'print',
    onError: (error) => log.warn(
      `PI subagent extension ${error.extensionPath} failed on ${error.event}: ${String(error.error)}`,
    ),
  });
  return { session: created.session, dispose: () => created.session.dispose() };
}
