// input:  installed pi executable, auth path, AuthInteraction
// output: PI runtime login handle and availability metadata
// pos:    Installed PI package loader
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthInteraction } from './login-flow.js';

export type PiCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown };

export interface PiApiKeyAuth {
  login?: (interaction: AuthInteraction) => Promise<Extract<PiCredential, { type: 'api_key' }>>;
}

export interface PiProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: { apiKey?: PiApiKeyAuth; oauth?: unknown };
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
}

interface PiRuntimeModule {
  ModelRuntime: {
    create(options: { authPath: string; allowModelNetwork: false }): Promise<PiModelRuntime>;
  };
  readStoredCredential(providerId: string, authPath?: string): PiCredential | undefined;
}

interface PiPackageJson {
  version?: unknown;
  exports?: { '.'?: { import?: unknown } };
}

interface DiscoveredPiPackage {
  version: string | null;
  entry: string;
}

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
  findPi?: () => string;
  authPath?: string;
  importModule?: (url: string) => Promise<unknown>;
}

function findInstalledPi(): string {
  const output = execFileSync('which', ['pi'], { encoding: 'utf8' });
  const executable = output.trim().split(/\r?\n/, 1)[0];
  if (!executable) throw new Error('pi not found');
  return executable;
}

function packageEntry(pkg: PiPackageJson): string {
  const exported = pkg.exports?.['.']?.import;
  return typeof exported === 'string' ? exported : './dist/index.js';
}

function discoverPiPackage(executable: string): DiscoveredPiPackage {
  const real = realpathSync(executable);
  const root = path.resolve(path.dirname(real), '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PiPackageJson;
  return {
    version: typeof pkg.version === 'string' ? pkg.version : null,
    entry: path.resolve(root, packageEntry(pkg)),
  };
}

function defaultImportModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

function unavailable(
  error: string,
  discovered?: DiscoveredPiPackage,
): PiRuntimeLoadResult {
  return {
    available: false,
    version: discovered?.version ?? null,
    entry: discovered?.entry ?? null,
    error,
    runtime: null,
    readStoredCredential: null,
  };
}

function isPiRuntimeModule(value: unknown): value is PiRuntimeModule {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PiRuntimeModule>;
  return typeof candidate.ModelRuntime?.create === 'function'
    && typeof candidate.readStoredCredential === 'function';
}

async function initializeRuntime(
  discovered: DiscoveredPiPackage,
  options: LoadPiRuntimeOptions,
): Promise<PiRuntimeLoadResult> {
  let imported: unknown;
  try {
    const importer = options.importModule ?? defaultImportModule;
    imported = await importer(pathToFileURL(discovered.entry).href);
  } catch {
    return unavailable('pi runtime import failed', discovered);
  }
  if (!isPiRuntimeModule(imported)) return unavailable('pi runtime exports unavailable', discovered);
  try {
    const authPath = options.authPath ?? path.join(os.homedir(), '.pi', 'agent', 'auth.json');
    const runtime = await imported.ModelRuntime.create({ authPath, allowModelNetwork: false });
    return { ...discovered, available: true, error: null, runtime, readStoredCredential: imported.readStoredCredential };
  } catch {
    return unavailable('pi runtime initialization failed', discovered);
  }
}

export async function loadPiRuntime(options: LoadPiRuntimeOptions = {}): Promise<PiRuntimeLoadResult> {
  let executable: string;
  try {
    executable = (options.findPi ?? findInstalledPi)();
  } catch {
    return unavailable('pi executable not found');
  }
  let discovered: DiscoveredPiPackage;
  try {
    discovered = discoverPiPackage(executable);
  } catch {
    return unavailable('pi package metadata unavailable');
  }
  return initializeRuntime(discovered, options);
}
