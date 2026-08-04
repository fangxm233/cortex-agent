// input:  config.set schema, CONFIG_DIR, runtime settings API
// output: validated budget, profile, and settings writes
// pos:    Mutation handler for the writable config sections
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import path from 'node:path';
import fs from 'node:fs/promises';
import { CONFIG_DIR } from '@core/paths.js';
import { atomicWrite } from '@core/atomic-write.js';
import { updateSettings } from '@core/settings.js';
import { costRepo } from '@store/cost-repo.js';
import { configSetInput } from '../input-schemas.js';
import type { UiServiceDeps, Result, ConfigSetArgs, ConfigSetReturn, BudgetValue } from '../types.js';

/**
 * Validate and atomically write budget.json into `configDir`. Pure over its dir argument
 * (hermetically testable against a temp dir). Re-validates through the same zod schema the router
 * uses, so a direct call (bypassing the router) cannot persist an illegal budget — it throws.
 *
 * READ-MODIFY-WRITE, not overwrite: budget.json carries the global limits AND a per-project
 * override map, and each write targets exactly one of them. A global write preserves every
 * override; a project write preserves the globals and the sibling overrides; an absent/null
 * `value` (project form only) deletes that one override.
 *
 * Project ids are NOT checked for existence here — this function stays hermetic over `configDir`
 * and has no project registry. The UI picks from a real project list, and the `!budget` command,
 * where typos are likely, validates against projectStore before calling into the domain.
 */
export async function writeBudget(
  configDir: string,
  value?: BudgetValue | null,
  project?: string | null,
): Promise<void> {
  const parsed = configSetInput.parse({ section: 'budget', project: project ?? null, value });
  if (parsed.section !== 'budget') throw new Error('unreachable: budget branch');

  const file = path.join(configDir, 'budget.json');
  let current: any = {};
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw;
  } catch {
    // Missing or malformed budget.json — start from an empty object rather than fail the write.
  }
  const projects: Record<string, BudgetValue> =
    current.projects && typeof current.projects === 'object' && !Array.isArray(current.projects)
      ? { ...current.projects }
      : {};

  let next: Record<string, unknown>;
  if (parsed.project) {
    if (parsed.value == null) delete projects[parsed.project];
    else projects[parsed.project] = parsed.value;
    next = { ...current, projects };
  } else {
    // The schema already rejects a missing value without a project.
    next = { ...current, ...parsed.value!, projects };
  }
  // `projects` is always emitted, even empty — the domain write path (costRepo, used by !budget)
  // serialises the whole BudgetConfig and would do the same, and one consistent on-disk shape
  // beats a file whose keys depend on which surface last wrote it.

  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Re-point profiles.json `defaultProfile`, PRESERVING every other field. Pure over its dir
 * argument. The target MUST already exist in the file's `profiles` map — the write can only SELECT
 * an existing profile, never invent one (a non-existent default would break agent startup). A
 * missing / malformed profiles.json or an unknown profile throws with `code: 'invalid-args'` so the
 * handler maps it to BAD_REQUEST rather than an internal error.
 */
export async function writeDefaultProfile(configDir: string, defaultProfile: string): Promise<void> {
  const file = path.join(configDir, 'profiles.json');
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw Object.assign(new Error('profiles.json is missing or unreadable'), { code: 'invalid-args' });
  }
  if (!raw || typeof raw !== 'object' || !raw.profiles || typeof raw.profiles !== 'object') {
    throw Object.assign(new Error('profiles.json has no profiles map'), { code: 'invalid-args' });
  }
  if (!Object.prototype.hasOwnProperty.call(raw.profiles, defaultProfile)) {
    throw Object.assign(new Error(`profile "${defaultProfile}" not found in profiles.json`), {
      code: 'invalid-args',
    });
  }
  const next = { ...raw, defaultProfile };
  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
}

export async function handleConfigSet(
  _deps: UiServiceDeps,
  args: ConfigSetArgs,
): Promise<Result<ConfigSetReturn>> {
  // Validate first (invalid-args → BAD_REQUEST), so a genuine write/IO failure below is not
  // misreported as bad input. Covers the section guard and each section's constraints in one pass.
  const parsed = configSetInput.safeParse(args);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-args', message: parsed.error.message };
  }
  try {
    if (parsed.data.section === 'budget') {
      await writeBudget(CONFIG_DIR, parsed.data.value, parsed.data.project);
      // budget.json was written out-of-band (atomicWrite, not through costRepo), so the cached
      // in-process budget must be dropped or the new limits would not apply until restart.
      costRepo.invalidateBudget();
      return { ok: true, data: { written: true, section: 'budget' } };
    }
    if (parsed.data.section === 'profiles') {
      await writeDefaultProfile(CONFIG_DIR, parsed.data.value.defaultProfile);
      return { ok: true, data: { written: true, section: 'profiles' } };
    }
    await updateSettings(parsed.data.value);
    return { ok: true, data: { written: true, section: 'settings' } };
  } catch (err: any) {
    const code = err?.code === 'invalid-args' ? 'invalid-args' : 'internal';
    return { ok: false, code, message: err?.message || String(err) };
  }
}
