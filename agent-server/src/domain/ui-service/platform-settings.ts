// input:  dotenv files, live environment, atomic mutation and schema
// output: redacted platform snapshots and serialized credential patches
// pos:    Platform configuration persistence and pending-state reader
// >>> Once updated, update this header and parent CORTEX.md <<<

import fs from 'node:fs/promises';
import { parse } from 'dotenv';
import { mutateFileAtomically } from '@core/atomic-write.js';
import {
  PLATFORM_FIELDS, PLATFORM_REQUIRED, PUBLIC_PLATFORM_FIELDS, platformSettingsInput,
  type MessagingPlatform, type PlatformFieldKey, type PlatformSettingsPatch,
  type PlatformSettingsSnapshot, type PlatformFieldSnapshot,
} from '@core/platform-settings-spec.js';

type Env = Record<string, string | undefined>;

function enabledPlatforms(env: Env): string[] {
  return (env.CORTEX_PLATFORM || 'slack').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function fieldValue(env: Env, key: PlatformFieldKey): string {
  return env[key] || (key === 'FEISHU_DOMAIN' ? 'feishu' : '');
}

function fieldSnapshot(key: PlatformFieldKey, saved: Env, live: Env): PlatformFieldSnapshot {
  const secret = !PUBLIC_PLATFORM_FIELDS.includes(key);
  return {
    key, secret, present: !!saved[key], runtimePresent: !!live[key],
    differs: fieldValue(saved, key) !== fieldValue(live, key),
    ...(!secret ? { value: fieldValue(saved, key) } : {}),
  };
}

function platformSnapshot(platform: MessagingPlatform, saved: Env, live: Env): PlatformSettingsSnapshot {
  const fields = PLATFORM_FIELDS[platform].map(key => fieldSnapshot(key, saved, live));
  const enabled = enabledPlatforms(saved).includes(platform);
  const runtimeEnabled = enabledPlatforms(live).includes(platform);
  return {
    platform, enabled, runtimeEnabled, fields,
    missing: PLATFORM_REQUIRED[platform].filter(key => !saved[key]),
    pendingRestart: enabled !== runtimeEnabled || fields.some(field => field.differs),
  };
}

async function readEnvFile(file: string): Promise<Env> {
  try { return parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Could not read platform configuration');
  }
}

export async function readPlatformSettings(
  file: string, live: Env = process.env,
): Promise<PlatformSettingsSnapshot[]> {
  const saved = await readEnvFile(file);
  return (['feishu', 'slack'] as const).map(platform => platformSnapshot(platform, saved, live));
}

/** Match the entire assignment (including multiline quoted values). Replacing all duplicates
 * prevents a later export/assignment from silently shadowing the new credential. Other lines
 * and comments are kept verbatim. Uses the same dotenv grammar as the loader for assignments. */
function replaceEnvValue(text: string, key: string, value: string): string {
  const assignments = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  const cleaned = text.replace(assignments, (assignment, name: string) => name === key ? '\n' : assignment);
  const prefix = cleaned && !cleaned.endsWith('\n') ? `${cleaned}\n` : cleaned;
  return `${prefix}${key}='${value}'\n`;
}

function patchContents(text: string, patch: PlatformSettingsPatch): string {
  let next = text;
  if (patch.enabled !== undefined) {
    const names = enabledPlatforms(parse(text)).filter(name => name !== patch.platform && name !== 'none');
    if (patch.enabled) names.push(patch.platform);
    next = replaceEnvValue(next, 'CORTEX_PLATFORM', [...new Set(names)].join(',') || 'none');
  }
  for (const [key, value] of Object.entries(patch.fields)) {
    if (value !== undefined) next = replaceEnvValue(next, key, value ?? '');
  }
  return next;
}

export async function writePlatformSettings(file: string, input: PlatformSettingsPatch): Promise<void> {
  const parsed = platformSettingsInput.safeParse(input);
  if (!parsed.success) throw new Error('Invalid platform configuration');
  await mutateFileAtomically(file, text => patchContents(text, parsed.data), { mode: 0o600 });
}
