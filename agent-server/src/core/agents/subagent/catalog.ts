import { ANTHROPIC_MODELS } from '@core/anthropic-models.js';
import type { Backend } from '@core/types/agent-types.js';
import type { AgentRole } from '../roles.js';
import { SUBAGENT_BACKEND_DESCRIPTION, SUBAGENT_MODEL_DESCRIPTION } from './schema.js';

export const MAX_SUBAGENT_MODEL_CHOICES = 32;
export const MAX_SUBAGENT_MODEL_LIST_CHARS = 1_200;
export const MAX_SUBAGENT_ROLE_CHOICES = 24;
export const MAX_SUBAGENT_ROLE_CHARS = 480;

export interface SubagentModelOption { backend: Backend; provider?: string; id: string }
export interface SubagentRoleOption { name: string; summary: string }
export interface SubagentCatalog { roles?: SubagentRoleOption[]; models?: SubagentModelOption[] }
export interface SubagentFieldDescriptions {
  subagentType: string;
  subagentTypeSingle: string;
  model: string;
  backend: string;
}

/** The static strings every field falls back to when its list is absent, so an empty catalog
 *  renders exactly the descriptions the tool shipped with. */
const STATIC_SUBAGENT_TYPE = 'Role name, such as explore, general-purpose, or plan.';
const STATIC_SUBAGENT_TYPE_SINGLE =
  'Role name for single mode, such as explore, general-purpose, or plan.';

/** Render one field's description from the catalog, degrading each field independently. */
export function describeSubagent(catalog: SubagentCatalog): SubagentFieldDescriptions {
  const roles = (catalog.roles ?? [])
    .map((role) => ({ name: role.name.trim(), summary: role.summary.trim() }))
    .filter((role) => role.name !== '')
    .sort((left, right) => left.name.localeCompare(right.name));
  const models = catalog.models ?? [];

  const available = roles.length > 0 ? ` Available here: ${renderRoleList(roles)}.` : '';
  return {
    subagentType: roles.length > 0 ? `Role name.${available}` : STATIC_SUBAGENT_TYPE,
    subagentTypeSingle: roles.length > 0
      ? `Role name for single mode.${available}`
      : STATIC_SUBAGENT_TYPE_SINGLE,
    model: describeModelField(models),
    backend: describeBackendField(models),
  };
}

/** Map role records to catalog entries: first sentence only, capped so the rendered list stays
 *  short. */
export function roleOptionsFrom(roles: AgentRole[]): SubagentRoleOption[] {
  const options: SubagentRoleOption[] = [];
  for (const role of roles) {
    const name = role.name.trim();
    if (!name) continue;
    options.push({ name, summary: summarizeRole(role.description) });
  }
  return options;
}

/** The claude catalog is the shipped Anthropic table plus the parent's own model when unknown.
 *  Table order is kept; an unknown current model is appended last. */
export function claudeModelOptions(currentModel?: string | null): SubagentModelOption[] {
  const options: SubagentModelOption[] = ANTHROPIC_MODELS.map(
    (id): SubagentModelOption => ({ backend: 'claude', id }),
  );
  const current = currentModel?.trim();
  if (current && !ANTHROPIC_MODELS.includes(current)) {
    options.push({ backend: 'claude', id: current });
  }
  return options;
}

/** Map discovered PI models to catalog entries, dropping entries that have no id to render. */
export function piModelOptions(
  models: ReadonlyArray<{ provider: string; id: string }>,
): SubagentModelOption[] {
  const options: SubagentModelOption[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const provider = model.provider.trim();
    options.push(provider ? { backend: 'pi', provider, id } : { backend: 'pi', id });
  }
  return options;
}

export function encodeSubagentModels(models: SubagentModelOption[]): string {
  return JSON.stringify(models);
}

/** Parse a persisted catalog defensively: malformed JSON, a non-array, or a bad entry is dropped
 *  rather than thrown, so a stale or corrupted value can never break tool registration. */
export function decodeSubagentModels(raw: string | undefined | null): SubagentModelOption[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: unknown[] = parsed;
  const models: SubagentModelOption[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { backend, provider, id } = item;
    if (backend !== 'claude' && backend !== 'pi') continue;
    if (typeof id !== 'string' || !id.trim()) continue;
    const model: SubagentModelOption = { backend, id: id.trim() };
    if (typeof provider === 'string' && provider.trim()) model.provider = provider.trim();
    models.push(model);
  }
  return models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trim, cut to the first sentence, drop its period, then hard-cap at 80 characters. */
function summarizeRole(description: string): string {
  const trimmed = description.trim();
  const boundary = trimmed.indexOf('. ');
  let summary = boundary >= 0 ? trimmed.slice(0, boundary) : trimmed;
  if (summary.endsWith('.')) summary = summary.slice(0, -1);
  if (summary.length > 80) summary = `${summary.slice(0, 80)}…`;
  return summary;
}

/** `provider/id` for pi (bare id when the provider is blank), always the bare id for claude. */
function modelName(model: SubagentModelOption): string | null {
  const id = model.id.trim();
  if (!id) return null;
  if (model.backend === 'claude') return id;
  const provider = model.provider?.trim() ?? '';
  return provider ? `${provider}/${id}` : id;
}

interface NamedModel {
  backend: Backend;
  name: string;
}

/** Deduplicate, order claude before pi (then by name), and apply the count and character caps. */
function boundedModels(models: SubagentModelOption[]): { selected: NamedModel[]; omitted: number } {
  const seen = new Set<string>();
  const named: NamedModel[] = [];
  for (const model of models) {
    const name = modelName(model);
    if (!name) continue;
    const key = `${model.backend}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    named.push({ backend: model.backend, name });
  }
  named.sort((left, right) => left.backend === right.backend
    ? left.name.localeCompare(right.name)
    : left.backend === 'claude' ? -1 : 1);

  // Same accumulation rule the PI tool used: an entry that would overflow the character budget is
  // skipped (not terminal), while the count cap stops the scan.
  const selected: NamedModel[] = [];
  let characters = 0;
  for (const entry of named) {
    if (selected.length >= MAX_SUBAGENT_MODEL_CHOICES) break;
    const added = entry.name.length + (selected.length > 0 ? 2 : 0);
    if (characters + added > MAX_SUBAGENT_MODEL_LIST_CHARS) continue;
    selected.push(entry);
    characters += added;
  }
  return { selected, omitted: named.length - selected.length };
}

function describeModelField(models: SubagentModelOption[]): string {
  const { selected, omitted } = boundedModels(models);
  const claude = selected.filter((entry) => entry.backend === 'claude').map((entry) => entry.name);
  const pi = selected.filter((entry) => entry.backend === 'pi').map((entry) => entry.name);
  const segments: string[] = [];
  if (claude.length > 0) segments.push(`claude: ${claude.join(', ')}`);
  if (pi.length > 0) segments.push(`pi: ${pi.join(', ')}`);
  if (segments.length === 0) return SUBAGENT_MODEL_DESCRIPTION;
  const suffix = omitted > 0 ? ` (+${omitted} more)` : '';
  return `${SUBAGENT_MODEL_DESCRIPTION} Known available — ${segments.join('; ')}${suffix}.`;
}

function describeBackendField(models: SubagentModelOption[]): string {
  let hasClaude = false;
  let hasPi = false;
  for (const model of models) {
    if (!modelName(model)) continue;
    if (model.backend === 'claude') hasClaude = true;
    else hasPi = true;
  }
  if (hasClaude && hasPi) {
    return `${SUBAGENT_BACKEND_DESCRIPTION} Both backends have models configured on this host.`;
  }
  if (hasClaude) {
    return `${SUBAGENT_BACKEND_DESCRIPTION} Only "claude" has models configured on this host.`;
  }
  if (hasPi) {
    return `${SUBAGENT_BACKEND_DESCRIPTION} Only "pi" has models configured on this host.`;
  }
  return SUBAGENT_BACKEND_DESCRIPTION;
}

/**
 * Render the roles list, degrading in order: `name — summary` entries, then bare names, then a
 * truncated names list with an omission suffix. Every step re-checks the character budget because
 * role summaries are user-authored and can be arbitrarily long.
 */
function renderRoleList(roles: SubagentRoleOption[]): string {
  const capped = roles.slice(0, MAX_SUBAGENT_ROLE_CHOICES);
  const droppedByCount = roles.length - capped.length;
  const countSuffix = droppedByCount > 0 ? ` (+${droppedByCount} more)` : '';

  const full = capped
    .map((role) => (role.summary ? `${role.name} — ${role.summary}` : role.name))
    .join('; ');
  if (full.length + countSuffix.length <= MAX_SUBAGENT_ROLE_CHARS) return full + countSuffix;

  const names = capped.map((role) => role.name).join(', ');
  if (names.length + countSuffix.length <= MAX_SUBAGENT_ROLE_CHARS) return names + countSuffix;

  // Keep whole names while the resulting list still fits, suffix included. Checking the suffix that
  // would follow each addition means the final rendered string is guaranteed within budget.
  const kept: string[] = [];
  let characters = 0;
  for (const role of capped) {
    const added = role.name.length + (kept.length > 0 ? 2 : 0);
    const omittedIfKept = roles.length - (kept.length + 1);
    const suffixIfKept = omittedIfKept > 0 ? ` (+${omittedIfKept} more)`.length : 0;
    if (characters + added + suffixIfKept > MAX_SUBAGENT_ROLE_CHARS) break;
    kept.push(role.name);
    characters += added;
  }
  const omitted = roles.length - kept.length;
  return kept.join(', ') + (omitted > 0 ? ` (+${omitted} more)` : '');
}
