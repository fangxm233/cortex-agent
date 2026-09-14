import type {
  ConfigProfileEntry, ModelCatalogRoute, ModelCatalogSnapshot, SessionSelectionOverride,
} from '@cortex-agent/ui-contract';
import { buildProfileOptions, currentBackendOf, type ProfileOption } from './profile-menu';
import type { SelectionChange } from './selected-session';

/** The gateway endpoint every claude profile leaves through — the server's own constant. */
const CLAUDE_ENDPOINT = 'anthropic';

// The composer's engine picker, as pure state.
//
// It reads the SAME `models.catalog` the profile editor picks from — one catalog per host, grouped
// by gateway endpoint — rather than a second list of its own.
//
// The product rule, mirrored from the server (domain/agents/model-selection.ts): a PROFILE is the
// base — it owns the backend, the gateway route and the fallback chain — and the user may override
// its model and thinking level on top. Backend therefore never changes by picking a model: a model
// on the other backend is reached by moving to a profile that runs it, which a live conversation
// cannot do (same rule as the profile switch; the server enforces it either way).

export type { ProfileOption };
export { buildProfileOptions, currentBackendOf };

export interface EffectiveSelection {
  profileName: string;
  backend: string;
  /** Effective values: the profile's, unless the session overrode them. */
  model: string | null;
  provider: string | null;
  thinking: string | null;
  /** Which gateway route of the endpoint bills the turn — anthropic `plan` vs `api`. */
  mode: string | null;
  modelOverridden: boolean;
  thinkingOverridden: boolean;
  modeOverridden: boolean;
}

/** One model as the picker handles it, flattened out of the catalog's per-endpoint routes. */
export interface ModelCatalogEntry {
  backend: string;
  provider?: string;
  id: string;
}

export interface ModelOption {
  id: string;
  backend: string;
  provider: string | null;
  /** Heading this option sits under: `claude`, or the PI provider's name. */
  group: string;
  active: boolean;
  disabled: boolean;
  /** Why it is disabled, for the tooltip: a live conversation cannot change backend, or this host
   *  has no profile that runs that backend at all. */
  disabledReason: 'cross-backend' | 'no-profile' | null;
  /** The profile the session must move to for this model. Null when the current profile already
   *  runs this backend — the server re-bases a PI provider change on its own. */
  profileName: string | null;
}

export interface ThinkingOption {
  level: string;
  active: boolean;
}

export interface ModeOption {
  mode: string;
  active: boolean;
}

function backendOf(profile: ConfigProfileEntry): string {
  return profile.backend ?? 'claude';
}

/** What the session will actually run: the profile, with the session's own choices on top. */
export function effectiveSelection(
  profiles: ConfigProfileEntry[],
  profileName: string,
  override: SessionSelectionOverride | null | undefined,
): EffectiveSelection {
  const profile = profiles.find((entry) => entry.name === profileName) ?? null;
  const backend = profile ? backendOf(profile) : 'claude';
  return {
    profileName,
    backend,
    model: override?.model ?? profile?.model ?? null,
    provider: override?.provider ?? profile?.provider ?? null,
    thinking: override?.thinking ?? profile?.thinking ?? null,
    mode: override?.mode ?? profile?.mode ?? null,
    modelOverridden: !!override?.model,
    thinkingOverridden: !!override?.thinking,
    modeOverridden: !!override?.mode,
  };
}

/**
 * The profile a model on another backend would land on: one that already runs that backend AND, if
 * possible, that provider — the configured route is better than a guessed one. Null when the host
 * has no profile for that backend, which is what makes such a model unpickable.
 */
export function profileForModel(
  profiles: ConfigProfileEntry[],
  entry: ModelCatalogEntry,
  defaultProfile: string | null,
): string | null {
  const sameBackend = profiles.filter((profile) => backendOf(profile) === entry.backend);
  if (sameBackend.length === 0) return null;
  const sameProvider = sameBackend.find((profile) => (profile.provider ?? null) === (entry.provider ?? null));
  if (sameProvider) return sameProvider.name;
  const fallbackDefault = sameBackend.find((profile) => profile.name === defaultProfile);
  return (fallbackDefault ?? sameBackend[0]).name;
}

/** The endpoint a selection leaves through: the PI provider, or the one Anthropic endpoint. */
function endpointOf(current: EffectiveSelection): string {
  return current.backend === 'pi' ? (current.provider ?? '') : CLAUDE_ENDPOINT;
}

function routeOf(
  catalog: ModelCatalogSnapshot | null | undefined, current: EffectiveSelection,
): ModelCatalogRoute | null {
  const endpoint = endpointOf(current);
  return catalog?.routes.find((route) => route.endpoint === endpoint) ?? null;
}

/** The catalog's routes flattened into one model list, in catalog order. */
export function catalogEntries(catalog: ModelCatalogSnapshot | null | undefined): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const route of catalog?.routes ?? []) {
    for (const id of route.models) {
      entries.push({ backend: route.backend, id, ...(route.provider ? { provider: route.provider } : {}) });
    }
  }
  return entries;
}

export function buildModelOptions(
  catalog: ModelCatalogSnapshot | null | undefined,
  profiles: ConfigProfileEntry[],
  current: EffectiveSelection,
  opts: { hasHistory: boolean; defaultProfile: string | null },
): ModelOption[] {
  const entries = catalogEntries(catalog);
  return entries.map((entry): ModelOption => {
    const sameBackend = entry.backend === current.backend;
    const target = sameBackend ? null : profileForModel(profiles, entry, opts.defaultProfile);
    const crossBackendBlocked = !sameBackend && opts.hasHistory;
    const unrunnable = !sameBackend && !target;
    return {
      id: entry.id,
      backend: entry.backend,
      provider: entry.provider ?? null,
      group: entry.backend === 'pi' ? (entry.provider ?? 'pi') : 'claude',
      active: sameBackend
        && entry.id === current.model
        && (entry.backend !== 'pi' || (entry.provider ?? null) === current.provider),
      disabled: crossBackendBlocked || unrunnable,
      disabledReason: crossBackendBlocked ? 'cross-backend' : unrunnable ? 'no-profile' : null,
      profileName: target,
    };
  });
}

/** Group order: the current backend's own models first (the ones a live session may actually pick),
 *  then the rest, each group keeping the catalog's order. */
export function groupModelOptions(
  options: ModelOption[],
  currentBackend: string,
): Array<{ group: string; backend: string; options: ModelOption[] }> {
  const groups: Array<{ group: string; backend: string; options: ModelOption[] }> = [];
  for (const option of options) {
    const existing = groups.find((entry) => entry.group === option.group);
    if (existing) existing.options.push(option);
    else groups.push({ group: option.group, backend: option.backend, options: [option] });
  }
  return [
    ...groups.filter((entry) => entry.backend === currentBackend),
    ...groups.filter((entry) => entry.backend !== currentBackend),
  ];
}

/**
 * The levels to offer: the chosen model's own ladder when the catalog could tell (PI reports it
 * per model), else the backend's whole set. Never narrower than what the catalog can vouch for —
 * hiding a level PI would have honoured is worse than showing one it refuses.
 */
export function buildThinkingOptions(
  catalog: ModelCatalogSnapshot | null | undefined,
  current: EffectiveSelection,
): ThinkingOption[] {
  const backendLevels = catalog?.thinkingLevels?.[current.backend as 'claude' | 'pi'] ?? [];
  const perModel = current.model ? routeOf(catalog, current)?.modelThinking?.[current.model] : undefined;
  const levels = perModel ?? backendLevels;
  return levels.map((level) => ({ level, active: level === current.thinking }));
}

/**
 * The billing routes the current endpoint declares — anthropic's `plan` (subscription) vs `api`
 * (metered key). One route is not a choice, so the section stays empty and the UI drops it.
 */
export function buildModeOptions(
  catalog: ModelCatalogSnapshot | null | undefined,
  current: EffectiveSelection,
): ModeOption[] {
  const modes = routeOf(catalog, current)?.modes ?? [];
  if (modes.length < 2) return [];
  return modes.map((mode) => ({ mode, active: mode === current.mode }));
}

/** Chip text, in one place because desktop and mobile must not disagree about it. `sub` is the part
 *  a narrow chip may drop. */
export function selectionChipParts(selection: EffectiveSelection): { main: string; sub: string | null } {
  return {
    main: selection.model ?? selection.profileName,
    sub: selection.thinking,
  };
}

// ── What a tap produces ─────────────────────────────────────────────────────────────────────────
// `sessions.setSelection` takes the WHOLE selection, never a patch: a field it does not carry goes
// back to following the profile. So every pick restates the current selection with one part changed.
// Desktop and mobile both go through here, which is what keeps them from disagreeing.

function restate(
  override: SessionSelectionOverride | null | undefined,
  patch: Partial<Record<'model' | 'provider' | 'thinking' | 'mode', string | undefined>>,
): SessionSelectionOverride {
  const next: SessionSelectionOverride = { ...(override ?? {}) };
  for (const field of ['model', 'provider', 'thinking', 'mode'] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value) next[field] = value;
    else delete next[field];
  }
  return next;
}

/** The change picking a profile row produces, or null when there is nothing to do. Deliberately
 *  carries no selection: naming a profile means "run it as declared", and the server drops the
 *  session's earlier overrides for exactly that reason. */
export function profileChange(
  options: ProfileOption[],
  current: EffectiveSelection,
  name: string,
): SelectionChange | null {
  const option = options.find((candidate) => candidate.name === name);
  if (!option || option.disabled || name === current.profileName) return null;
  return { profileName: name };
}

/** The change picking a model row produces — `null` for the "follow the profile" row. Returns null
 *  when the row is not actionable (already running, disabled, or nothing to take back). */
export function modelChange(
  current: EffectiveSelection,
  override: SessionSelectionOverride | null | undefined,
  option: ModelOption | null,
): SelectionChange | null {
  if (!option) {
    if (!current.modelOverridden) return null;
    return { selection: restate(override, { model: undefined, provider: undefined }) };
  }
  if (option.disabled || option.active) return null;
  // Moving profile restates the selection from scratch: the old model belonged to the old backend,
  // and its thinking level may not even exist on the new one.
  if (option.profileName) {
    return {
      profileName: option.profileName,
      selection: { model: option.id, ...(option.provider ? { provider: option.provider } : {}) },
    };
  }
  return { selection: restate(override, { model: option.id, provider: option.provider ?? undefined }) };
}

/** The change picking a thinking row produces — `null` level is the "follow the profile" row. */
export function thinkingChange(
  current: EffectiveSelection,
  override: SessionSelectionOverride | null | undefined,
  level: string | null,
): SelectionChange | null {
  if (level === null) {
    if (!current.thinkingOverridden) return null;
    return { selection: restate(override, { thinking: undefined }) };
  }
  if (level === current.thinking) return null;
  return { selection: restate(override, { thinking: level }) };
}

/** The change picking a billing route produces — `null` route is the "follow the profile" row. */
export function modeChange(
  current: EffectiveSelection,
  override: SessionSelectionOverride | null | undefined,
  mode: string | null,
): SelectionChange | null {
  if (mode === null) {
    if (!current.modeOverridden) return null;
    return { selection: restate(override, { mode: undefined }) };
  }
  if (mode === current.mode) return null;
  return { selection: restate(override, { mode }) };
}

// ── What the picker actually SHOWS ──────────────────────────────────────────────────────────────
// The rule above decides what is pickable; this decides what is drawn. A row nobody can click is
// noise — a live PI conversation has no use for 17 greyed-out claude models — so an unpickable
// option is dropped and the count is reported instead, for the one footer line that says why.

export interface VisibleModelOptions {
  /** Only the options a click would actually change something with. */
  options: ModelOption[];
  /** Hidden because a live conversation may not change backend — a new conversation could. */
  hiddenCrossBackend: number;
  /** The backend those hidden models run on. Only two backends exist, and "cross-backend" means
   *  "not the current one", so they all share it; the first one answers for the group. */
  hiddenBackend: string | null;
  /** Hidden because this host has no profile for that backend at all — a new conversation would not
   *  help either; a profile has to be made first. */
  hiddenNoProfile: number;
}

export function visibleModelOptions(options: ModelOption[]): VisibleModelOptions {
  const crossBackend = options.filter((option) => option.disabledReason === 'cross-backend');
  return {
    options: options.filter((option) => !option.disabled),
    hiddenCrossBackend: crossBackend.length,
    hiddenBackend: crossBackend[0]?.backend ?? null,
    hiddenNoProfile: options.filter((option) => option.disabledReason === 'no-profile').length,
  };
}

/** The same rule for the profile list: a profile the conversation cannot move to is not drawn. */
export function visibleProfileOptions(options: ProfileOption[]): {
  options: ProfileOption[];
  hidden: number;
  hiddenBackend: string | null;
} {
  const hidden = options.filter((option) => option.disabled);
  return {
    options: options.filter((option) => !option.disabled),
    hidden: hidden.length,
    hiddenBackend: hidden[0]?.backend ?? null,
  };
}

/** One collapsed override on the picker's root: what it is, what it is currently worth, and whether
 *  that value is the session's own choice or just what the profile says. */
export interface SelectionRootRow {
  key: 'model' | 'thinking' | 'mode';
  label: string;
  value: string;
  overridden: boolean;
}

const NO_VALUE = '—';

/**
 * The root's collapsed rows — the effective value, never "follow profile", so the next turn's engine
 * reads off the root without opening anything. A level or route the session cannot choose at all
 * (the backend reports no ladder, the endpoint bills one way) has no row, the same condition that
 * used to drop the whole section.
 */
export function selectionRootRows(
  current: EffectiveSelection,
  copy: { model: string; thinking: string; mode: string },
  opts: { hasThinking: boolean; hasModes: boolean },
): SelectionRootRow[] {
  return [
    {
      key: 'model' as const,
      label: copy.model,
      value: current.model ?? NO_VALUE,
      overridden: current.modelOverridden,
    },
    ...(opts.hasThinking ? [{
      key: 'thinking' as const,
      label: copy.thinking,
      value: current.thinking ?? NO_VALUE,
      overridden: current.thinkingOverridden,
    }] : []),
    ...(opts.hasModes ? [{
      key: 'mode' as const,
      label: copy.mode,
      value: current.mode ?? NO_VALUE,
      overridden: current.modeOverridden,
    }] : []),
  ];
}

/** Hand every override back to the profile in one move. `{}` states a selection that carries no
 *  field, which is exactly how the server reads "all of it follows the profile again". Null when
 *  there is nothing to take back. */
export function clearAllChange(current: EffectiveSelection): SelectionChange | null {
  if (!current.modelOverridden && !current.thinkingOverridden && !current.modeOverridden) return null;
  return { selection: {} };
}
