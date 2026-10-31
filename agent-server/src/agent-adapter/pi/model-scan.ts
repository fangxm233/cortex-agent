import * as path from 'node:path';
import { loadPiSdk, piUserModelsPath } from '@core/pi-sdk.js';
import { applyRuntimeKeys } from './providers-config.js';
import { piAuthPath } from './defaults.js';

export interface PiDiscoveredModel {
  provider: string;
  model: string;
  /** Thinking levels this specific model accepts, ascending. Empty means the model takes none (a
   *  non-reasoning model). Undefined means the scan could not tell — callers fall back to the
   *  backend-wide set rather than hiding levels PI would have honoured. */
  thinkingLevels?: string[];
}

/** The ascending thinking-level ladder PI's own selector walks. */
const PI_THINKING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The two fields of a PI model that decide its thinking levels. Read structurally because the SDK
 *  re-exports neither the `Model` type's full shape nor the helper that consumes them. */
interface PiModelThinkingShape {
  reasoning?: unknown;
  thinkingLevelMap?: Record<string, unknown>;
}

/**
 * The thinking levels one PI model accepts.
 *
 * Mirrors pi-ai's own `getSupportedThinkingLevels`, which `@earendil-works/pi-coding-agent` does not
 * re-export: a non-reasoning model takes none; otherwise every ladder rung survives unless the
 * model's `thinkingLevelMap` maps it to null, and the top two rungs (`xhigh`, `max`) additionally
 * require an explicit mapping. Returns undefined when neither field is present, so the caller can
 * tell "no levels" from "could not tell".
 *
 * Re-check against pi-ai when the PI SDK is upgraded.
 */
export function piModelThinkingLevels(model: unknown): string[] | undefined {
  const shape = model as PiModelThinkingShape | null;
  if (!shape || typeof shape !== 'object') return undefined;
  if (!('reasoning' in shape) && !('thinkingLevelMap' in shape)) return undefined;
  if (!shape.reasoning) return [];
  const map = shape.thinkingLevelMap;
  return PI_THINKING_LADDER.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    return level === 'xhigh' || level === 'max' ? mapped !== undefined : true;
  });
}

export interface PiModelScanPaths {
  authPath: string;
  modelsPath: string;
  /** An agent dir whose runtime keys the scan installs first, as a session over it would. */
  agentDir?: string;
}

/**
 * List the PI models whose provider has usable auth, exactly as `pi --list-models` would report
 * them over the given credential store and catalog: builtin catalog plus the catalog's blocks, no
 * network refresh. PI is the authoritative source of model metadata — cortex does not maintain a
 * whitelist. Rejects when the SDK cannot be loaded or the runtime fails to initialize.
 */
export async function scanPiModels(paths: PiModelScanPaths): Promise<PiDiscoveredModel[]> {
  const { ModelRuntime } = await loadPiSdk();
  const runtime = await ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork: false,
  });
  if (paths.agentDir) await applyRuntimeKeys(runtime, paths.agentDir);
  const models = await runtime.getAvailable();
  return models.map((model) => {
    const thinkingLevels = piModelThinkingLevels(model);
    // Omitted rather than set to undefined: "the scan could not tell" is the absence of the field.
    return { provider: model.provider, model: model.id, ...(thinkingLevels ? { thinkingLevels } : {}) };
  });
}

/** PI's own catalog in PI's own home — what a process that runs no PI session of its own sees. */
export function scanUserPiModels(): Promise<PiDiscoveredModel[]> {
  return scanPiModels({ authPath: piAuthPath(), modelsPath: piUserModelsPath() });
}

/** The catalog a PI session over `agentDir` runs with: its auth, its models.json, its runtime keys. */
export function scanAgentDirModels(agentDir: string): Promise<PiDiscoveredModel[]> {
  return scanPiModels({
    authPath: piAuthPath(agentDir),
    modelsPath: path.join(agentDir, 'models.json'),
    agentDir,
  });
}
