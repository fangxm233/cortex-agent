// input:  profiles.* schemas, CONFIG_DIR, profiles.json on disk
// output: create / update / remove writes over the profiles map
// pos:    Mutation handlers for the profiles.* operations
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import path from 'node:path';
import fs from 'node:fs/promises';
import { CONFIG_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { validateProfilesFile, type ProfileEntry } from '@domain/agents/profile-manager.js';
import type {
  UiServiceDeps,
  Result,
  ProfileDraftInput,
  ProfilesCreateArgs,
  ProfilesCreateReturn,
  ProfilesUpdateArgs,
  ProfilesUpdateReturn,
  ProfilesRemoveArgs,
  ProfilesRemoveReturn,
} from '../types.js';

/**
 * These handlers own the `profiles` map of profiles.json; `config.set {section:'profiles'}` still
 * owns `defaultProfile`. Writes land through atomicWrite, which trips the profiles.json watcher
 * (store/profile-repo.ts startProfileWatcher) — a running server picks the change up without a
 * restart, exactly as a hand edit does.
 */

interface RawProfilesFile {
  defaultProfile?: unknown;
  profiles: Record<string, ProfileEntry>;
  [key: string]: unknown;
}

function fail(code: 'invalid-args' | 'not-found', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function profilesPath(configDir: string): string {
  return path.join(configDir, 'profiles.json');
}

/** Read the file whole so every field we do not manage (defaultProfile, any future key) survives. */
async function readProfilesFile(configDir: string): Promise<RawProfilesFile> {
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(profilesPath(configDir), 'utf8'));
  } catch {
    throw fail('invalid-args', 'profiles.json is missing or unreadable');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.profiles
    || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
    throw fail('invalid-args', 'profiles.json has no profiles map');
  }
  return raw as RawProfilesFile;
}

async function writeProfilesFile(configDir: string, next: RawProfilesFile): Promise<void> {
  await atomicWrite(profilesPath(configDir), JSON.stringify(next, null, 2) + '\n');
}

/**
 * Assemble the stored entry from the draft. Optional fields the draft omits are DROPPED (the draft
 * is the complete desired state for everything the editor can express), while `extraEnv` and
 * `fallback` are carried over from `preserved` — the UI cannot express either (extraEnv values are
 * secret-bearing and never leave the server; fallback is a nested chain with no editor), so an edit
 * must not silently delete them. Key order matches how init writes the file.
 */
export function buildProfileEntry(draft: ProfileDraftInput, preserved?: ProfileEntry): ProfileEntry {
  const entry: ProfileEntry = { model: draft.model };
  if (draft.backend !== undefined) entry.backend = draft.backend;
  if (draft.mode !== undefined) entry.mode = draft.mode;
  if (draft.provider !== undefined) entry.provider = draft.provider;
  if (preserved?.extraEnv !== undefined) entry.extraEnv = preserved.extraEnv;
  if (draft.extraOption !== undefined && Object.keys(draft.extraOption).length > 0) {
    entry.extraOption = draft.extraOption;
  }
  if (draft.claudeBackend !== undefined) entry.claudeBackend = draft.claudeBackend;
  if (draft.thinking !== undefined) entry.thinking = draft.thinking;
  if (preserved?.fallback !== undefined) entry.fallback = preserved.fallback;
  return entry;
}

/**
 * Run the shipped file validator over a ONE-ENTRY probe file rather than the assembled result.
 * Same code path — name charset, backend enum, the pi-needs-a-provider rule, per-backend thinking
 * levels, extraEnv/extraOption shapes, and the fallback chain re-checked against the (possibly
 * changed) primary backend — but scoped to the entry being written, so a pre-existing hand-broken
 * neighbour entry cannot block editing an unrelated profile.
 */
function assertValidEntry(name: string, entry: ProfileEntry): void {
  try {
    validateProfilesFile({ defaultProfile: name, profiles: { [name]: entry } });
  } catch (error) {
    throw fail('invalid-args', error instanceof Error ? error.message : String(error));
  }
}

export async function createProfile(configDir: string, args: ProfilesCreateArgs): Promise<void> {
  const { name, ...draft } = args;
  const raw = await readProfilesFile(configDir);
  if (Object.prototype.hasOwnProperty.call(raw.profiles, name)) {
    throw fail('invalid-args', `profile "${name}" already exists`);
  }
  const entry = buildProfileEntry(draft);
  assertValidEntry(name, entry);
  await writeProfilesFile(configDir, { ...raw, profiles: { ...raw.profiles, [name]: entry } });
}

export async function updateProfile(configDir: string, args: ProfilesUpdateArgs): Promise<boolean> {
  const { name, ...draft } = args;
  const raw = await readProfilesFile(configDir);
  const current = raw.profiles[name];
  if (!current) throw fail('not-found', `profile "${name}" not found in profiles.json`);
  const entry = buildProfileEntry(draft, current);
  assertValidEntry(name, entry);
  const changed = JSON.stringify(entry) !== JSON.stringify(current);
  if (changed) {
    await writeProfilesFile(configDir, { ...raw, profiles: { ...raw.profiles, [name]: entry } });
  }
  return changed;
}

/**
 * Deleting the profile `defaultProfile` points at would leave every agent start resolving a
 * missing profile, and deleting the last one leaves nothing to resolve at all. Both are refused
 * with the remedy in the message rather than written and then discovered at spawn time.
 */
export async function removeProfile(configDir: string, args: ProfilesRemoveArgs): Promise<void> {
  const { name } = args;
  const raw = await readProfilesFile(configDir);
  if (!Object.prototype.hasOwnProperty.call(raw.profiles, name)) {
    throw fail('not-found', `profile "${name}" not found in profiles.json`);
  }
  if (raw.defaultProfile === name) {
    throw fail('invalid-args', `profile "${name}" is the default profile — point the default at another profile first`);
  }
  const rest = { ...raw.profiles };
  delete rest[name];
  if (Object.keys(rest).length === 0) {
    throw fail('invalid-args', 'cannot remove the last profile in profiles.json');
  }
  await writeProfilesFile(configDir, { ...raw, profiles: rest });
}

/** Writer errors carry `code`; anything else is a genuine internal failure. */
function toErr(error: unknown): Result<never> {
  const code = (error as { code?: unknown })?.code;
  return {
    ok: false,
    code: code === 'not-found' || code === 'invalid-args' ? code : 'internal',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function handleProfilesCreate(
  _deps: UiServiceDeps,
  args: ProfilesCreateArgs,
): Promise<Result<ProfilesCreateReturn>> {
  try {
    await createProfile(CONFIG_DIR, args);
    return { ok: true, data: { name: args.name } };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleProfilesUpdate(
  _deps: UiServiceDeps,
  args: ProfilesUpdateArgs,
): Promise<Result<ProfilesUpdateReturn>> {
  try {
    return { ok: true, data: { changed: await updateProfile(CONFIG_DIR, args) } };
  } catch (error) {
    return toErr(error);
  }
}

export async function handleProfilesRemove(
  _deps: UiServiceDeps,
  args: ProfilesRemoveArgs,
): Promise<Result<ProfilesRemoveReturn>> {
  try {
    await removeProfile(CONFIG_DIR, args);
    return { ok: true, data: { removed: true } };
  } catch (error) {
    return toErr(error);
  }
}
