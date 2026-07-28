// input:  Discovered endpoints and explicit model/fallback choices
// output: Profile generation, merge, write, and choice helpers
// pos:    Generates Claude/PI profiles from discovered models
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { DiscoveredEndpoint } from './gateway-generator.js';
import { createLogger } from './log.js';

const log = createLogger('profile-generator');

// ─── Types ────────────────────────────────────────────────────────

interface ProfileEntry {
  model: string;
  backend: string;
  mode: string;
  /** PI `--provider` (= gateway endpoint group). Required for PI; omitted for Claude. */
  provider?: string;
  fallback?: ProfileEntry[];
  extraEnv?: Record<string, string>;
  extraOption?: Record<string, string>;
}

interface ProfilesFile {
  defaultProfile: string;
  profiles: Record<string, ProfileEntry>;
}

/** A (mode, model) pair the user can pick as the source for plan/execute or fallback. */
export interface ModelChoice {
  mode: string;
  model: string;
}

export interface GenerateOpts {
  /** Explicit (mode, model) to use as the `plan` profile. Otherwise the first lexicographic choice. */
  planChoice?: ModelChoice;
  /** Explicit (mode, model) to use as the `execute` profile. Same default rule as planChoice. */
  executeChoice?: ModelChoice;
  /** Ordered fallback chain for the `plan` profile. */
  planFallback?: ModelChoice[];
  /** Ordered fallback chain for the `execute` profile. */
  executeFallback?: ModelChoice[];
  /** Additional models to register as standalone named profiles (profile name = model name). */
  extraProfiles?: ModelChoice[];
}

// ─── Endpoint → backend mapping ────────────────────────────────────

/**
 * Determine the Cortex backend from endpoint and mode.
 * - anthropic endpoint with plan/api mode → claude (Claude Code CLI)
 * - everything else → pi (PI agent CLI handles all other providers, including OAuth ones like openai-codex)
 */
function resolveBackend(endpoint: string, mode: string): string {
  if (endpoint === 'anthropic' && (mode === 'plan' || mode === 'api')) {
    return 'claude';
  }
  return 'pi';
}

// ─── Model entry flattening ───────────────────────────────────────

interface ModelEntry {
  model: string;
  backend: string;
  mode: string;
  endpoint: string;
}

/** Flatten all discovered endpoints into a list of (model, backend, mode) entries. */
function flattenModels(endpoints: DiscoveredEndpoint[]): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const ep of endpoints) {
    const backend = resolveBackend(ep.endpoint, ep.mode);
    for (const model of ep.models) {
      entries.push({
        model,
        backend,
        mode: ep.mode,
        endpoint: ep.endpoint,
      });
    }
  }
  return entries;
}

/** Locate a ModelEntry by explicit (mode, model). Throws if not found. */
function findModelEntry(models: ModelEntry[], choice: ModelChoice, label: string): ModelEntry {
  const match = models.find(m => m.mode === choice.mode && m.model === choice.model);
  if (!match) {
    throw new Error(
      `${label}: (mode="${choice.mode}", model="${choice.model}") not found among discovered models`,
    );
  }
  return match;
}

/** Build a ProfileEntry from a ModelEntry (no fallback chain attached yet). */
function makeProfileEntry(m: ModelEntry): ProfileEntry {
  const entry: ProfileEntry = {
    model: m.model,
    backend: m.backend,
    mode: m.mode,
  };
  // PI backends require an explicit `provider` (the PI `--provider` / gateway endpoint group).
  // For discovered PI providers, endpoint === provider name (discoverEndpoints sets mode = endpoint
  // = provider), so the gateway URL `/m/<mode>/<provider>` lands on the generated `<endpoint>:
  // { <mode>: ... }` route. Claude profiles carry no provider.
  if (m.backend === 'pi') {
    entry.provider = m.endpoint;
  }
  return entry;
}

/** Build fallback entries from explicit user choices. Throws if any choice can't be resolved. */
function resolveFallbackChain(
  models: ModelEntry[],
  fallback: ModelChoice[] | undefined,
  label: string,
): ProfileEntry[] | undefined {
  if (!fallback || fallback.length === 0) return undefined;
  return fallback.map((choice, i) => {
    const m = findModelEntry(models, choice, `${label} fallback[${i}]`);
    return makeProfileEntry(m);
  });
}

// ─── Choice listing (for init UI) ─────────────────────────────────

/**
 * Flatten endpoints to a list of (mode, model) choices the user can pick from.
 * Strictly sorted by (mode ASC, model ASC) — no tier or provider preference.
 */
export function listChoices(endpoints: DiscoveredEndpoint[]): ModelChoice[] {
  const flat = flattenModels(endpoints);
  flat.sort((a, b) => {
    const cmp = a.mode.localeCompare(b.mode);
    return cmp !== 0 ? cmp : a.model.localeCompare(b.model);
  });
  return flat.map(m => ({ mode: m.mode, model: m.model }));
}

// ─── Main generation ──────────────────────────────────────────────

/**
 * Generate a profiles.json object from discovered endpoints.
 *
 * Generates exactly two profiles: `plan` and `execute`.
 * - If `planChoice` is omitted, picks the first lexicographic (mode, model) tuple.
 * - Same default rule for `execute`.
 * - Fallback chains are taken verbatim from `planFallback` / `executeFallback` (no auto-derivation).
 * - No tier classification or auto-generated provider tiers — users explicitly choose
 *   what they want via cortex init's interactive UI.
 */
export function generateProfiles(
  endpoints: DiscoveredEndpoint[],
  opts: GenerateOpts = {},
): ProfilesFile {
  const models = flattenModels(endpoints);

  if (models.length === 0) {
    // Minimal fallback — user needs to log in first
    return {
      defaultProfile: 'plan',
      profiles: {
        plan: { model: 'opus', backend: 'claude', mode: 'plan' },
      },
    };
  }

  // Lexicographic default: first choice in listChoices order
  const sorted = listChoices(endpoints);
  const defaultChoice = sorted[0];

  const planEntry = findModelEntry(
    models,
    opts.planChoice ?? defaultChoice,
    'planChoice',
  );
  const executeEntry = findModelEntry(
    models,
    opts.executeChoice ?? defaultChoice,
    'executeChoice',
  );

  const planFallback = resolveFallbackChain(models, opts.planFallback, 'planChoice');
  const executeFallback = resolveFallbackChain(models, opts.executeFallback, 'executeChoice');

  const planProfile: ProfileEntry = makeProfileEntry(planEntry);
  if (planFallback) planProfile.fallback = planFallback;

  const executeProfile: ProfileEntry = makeProfileEntry(executeEntry);
  if (executeFallback) executeProfile.fallback = executeFallback;

  const profiles: Record<string, ProfileEntry> = {
    plan: planProfile,
    execute: executeProfile,
  };

  // Extra profiles: user-picked additional models to register as standalone named profiles.
  // Profile name = model name (e.g., selecting deepseek-v4-pro → profile "deepseek-v4-pro").
  if (opts.extraProfiles && opts.extraProfiles.length > 0) {
    for (const choice of opts.extraProfiles) {
      // Profile names must match /^[a-zA-Z0-9_-]+$/. Model ids may contain dots (e.g. "gpt-5.4"),
      // which are invalid in a profile name — sanitize dots → dashes. The model id stored in the
      // entry stays verbatim (makeProfileEntry uses choice.model) so the API call is unaffected.
      const name = choice.model.replace(/\./g, '-');
      if (name === 'plan' || name === 'execute') {
        log.warn(`Skipping extra profile "${name}": name conflicts with managed profile`);
        continue;
      }
      if (profiles[name]) {
        log.warn(`Skipping extra profile "${name}": already exists`);
        continue;
      }
      const entry = findModelEntry(models, choice, `extraProfiles[${name}]`);
      profiles[name] = makeProfileEntry(entry);
      log.info(`Added extra profile: ${name} (mode=${entry.mode}, backend=${entry.backend})`);
    }
  }

  return { defaultProfile: 'plan', profiles };
}

// ─── File I/O ─────────────────────────────────────────────────────

/**
 * Merge generated profiles into existing profiles.json.
 * - Non-(plan/execute) existing profiles are always preserved.
 * - For `plan` and `execute`: `overwrite=true` replaces them with generated;
 *   `overwrite=false` (default) preserves existing user customization.
 * - defaultProfile is only updated if the current default doesn't exist in merged.
 */
export function mergeProfilesJson(
  generated: ProfilesFile,
  outputDir?: string,
  overwrite: boolean = false,
): ProfilesFile {
  const existingPath = outputDir
    ? path.join(outputDir, 'profiles.json')
    : path.join(os.homedir(), '.cortex', 'config', 'profiles.json');

  let existing: ProfilesFile | null = null;

  try {
    if (existsSync(existingPath)) {
      existing = JSON.parse(readFileSync(existingPath, 'utf-8'));
    }
  } catch (e) {
    log.warn(`Failed to read existing profiles.json: ${(e as Error).message}`);
  }

  if (!existing || !existing.profiles) {
    return generated;
  }

  const merged: Record<string, ProfileEntry> = { ...existing.profiles };

  for (const [name, profile] of Object.entries(generated.profiles)) {
    const isManaged = name === 'plan' || name === 'execute';
    if (!merged[name]) {
      merged[name] = profile;
      log.info(`Added new profile: ${name}`);
    } else if (isManaged && overwrite) {
      merged[name] = profile;
      log.info(`Overwrote managed profile: ${name}`);
    }
    // else: preserve existing
  }

  // Keep existing defaultProfile if it still exists in merged profiles
  let defaultProfile = existing.defaultProfile;
  if (!merged[defaultProfile]) {
    defaultProfile = generated.defaultProfile;
  }

  return { defaultProfile, profiles: merged };
}

export interface WriteProfilesOpts extends GenerateOpts {
  /** Output directory. Defaults to ~/.cortex/config. */
  outputDir?: string;
  /** Force overwrite of existing `plan` / `execute` profiles. Default false. */
  overwrite?: boolean;
  /** Additional models to register as standalone named profiles. */
  extraProfiles?: ModelChoice[];
}

/**
 * Write profiles.json to ~/.cortex/config/profiles.json (or outputDir/profiles.json).
 * Merges with existing file to preserve user customizations unless overwrite=true.
 */
export function writeProfilesJson(
  endpoints: DiscoveredEndpoint[],
  optsOrOutputDir?: WriteProfilesOpts | string,
): string {
  // Back-compat: previous signature was (endpoints, outputDir?: string)
  const opts: WriteProfilesOpts = typeof optsOrOutputDir === 'string'
    ? { outputDir: optsOrOutputDir }
    : (optsOrOutputDir ?? {});

  const generated = generateProfiles(endpoints, {
    planChoice: opts.planChoice,
    executeChoice: opts.executeChoice,
    planFallback: opts.planFallback,
    executeFallback: opts.executeFallback,
    extraProfiles: opts.extraProfiles,
  });
  const merged = mergeProfilesJson(generated, opts.outputDir, opts.overwrite ?? false);

  const configDir = opts.outputDir || path.join(os.homedir(), '.cortex', 'config');
  const outputPath = path.join(configDir, 'profiles.json');

  mkdirSync(configDir, { recursive: true });

  const content = JSON.stringify(merged, null, 2) + '\n';
  writeFileSync(outputPath, content, 'utf-8');
  log.info(`Written profiles.json to ${outputPath}`);

  return outputPath;
}
