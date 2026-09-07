// input:  bundled PI SDK module, auth path, AuthInteraction
// output: PI runtime login/logout handle and availability metadata
// pos:    Bundled PI SDK runtime loader
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'node:path';
import { loadPiSdk, piUserAuthPath } from '@core/pi-sdk.js';
import type { AuthInteraction } from './login-flow.js';

export type PiCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown };

export interface PiApiKeyAuth {
  login?: (interaction: AuthInteraction) => Promise<Extract<PiCredential, { type: 'api_key' }>>;
}

export interface PiOAuthAuth {
  login?: (interaction: AuthInteraction) => Promise<Extract<PiCredential, { type: 'oauth' }>>;
}

export interface PiProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: { apiKey?: PiApiKeyAuth; oauth?: PiOAuthAuth };
}

export interface PiProviderAuthStatus {
  configured: boolean;
  source?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command';
  label?: string;
}

export interface PiModelRuntime {
  getProviders(): readonly PiProvider[];
  getProviderAuthStatus(providerId: string): PiProviderAuthStatus;
  login(
    providerId: string,
    type: 'api_key' | 'oauth',
    interaction: AuthInteraction,
  ): Promise<PiCredential>;
  logout(providerId: string): Promise<void>;
}

interface PiRuntimeModule {
  VERSION?: unknown;
  ModelRuntime: {
    create(options: { authPath: string; modelsPath: string; allowModelNetwork: false }): Promise<PiModelRuntime>;
  };
  readStoredCredential(providerId: string, authPath?: string): PiCredential | undefined;
}

/** Package that provides the runtime; reported in place of an on-disk entry path. */
export const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

export type PiRuntimeLoadResult =
  | {
    available: true;
    version: string | null;
    entry: string;
    error: null;
    runtime: PiModelRuntime;
    readStoredCredential: PiRuntimeModule['readStoredCredential'];
  }
  | {
    available: false;
    version: string | null;
    entry: string | null;
    error: string;
    runtime: null;
    readStoredCredential: null;
  };

export interface LoadPiRuntimeOptions {
  authPath?: string;
  /** Test seam: supplies the PI module instead of the bundled SDK. */
  importModule?: () => Promise<unknown>;
}

function unavailable(error: string, version: string | null = null): PiRuntimeLoadResult {
  return { available: false, version, entry: null, error, runtime: null, readStoredCredential: null };
}

function isPiRuntimeModule(value: unknown): value is PiRuntimeModule {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PiRuntimeModule>;
  return typeof candidate.ModelRuntime?.create === 'function'
    && typeof candidate.readStoredCredential === 'function';
}

export async function loadPiRuntime(options: LoadPiRuntimeOptions = {}): Promise<PiRuntimeLoadResult> {
  let imported: unknown;
  try {
    imported = await (options.importModule ?? loadPiSdk)();
  } catch {
    return unavailable('pi runtime import failed');
  }
  if (!isPiRuntimeModule(imported)) return unavailable('pi runtime exports unavailable');
  const version = typeof imported.VERSION === 'string' ? imported.VERSION : null;
  try {
    // models.json lives beside auth.json; pass it explicitly so the SDK never consults
    // PI_CODING_AGENT_DIR from this process's environment.
    const authPath = options.authPath ?? piUserAuthPath();
    const modelsPath = path.join(path.dirname(authPath), 'models.json');
    const runtime = await imported.ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
    return {
      available: true, version, entry: PI_SDK_PACKAGE, error: null,
      runtime, readStoredCredential: imported.readStoredCredential,
    };
  } catch {
    return unavailable('pi runtime initialization failed', version);
  }
}
