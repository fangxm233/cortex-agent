// input:  ConfigProfileEntry DTO and the profiles.* mutation arg types
// output: profile form state, validation and mutation args
// pos:    View model for the settings profiles panel
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type {
  ConfigProfileEntry,
  ProfileDraftInput,
  ProfilesCreateArgs,
  ProfilesUpdateArgs,
} from '@cortex-agent/ui-contract';

// Pure derivations for ProfilesPanel: form state in and out of the read DTO, the client-side echo of
// the server's profile rules (so a bad field is caught before a round-trip), and the mutation args.
// The server re-validates everything through validateProfilesFile — this module never widens what
// the server accepts, it only reports the same refusal earlier.

export type ProfileBackend = 'claude' | 'pi';

export const PROFILE_BACKENDS: readonly ProfileBackend[] = ['claude', 'pi'];

export type ProfileClaudeBackend = 'print' | 'tui';

/** Mirrors THINKING_LEVELS_BY_BACKEND in agent-server domain/agents/profile-manager.ts. */
export const THINKING_LEVELS: Readonly<Record<ProfileBackend, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface ProfileOptionRow {
  key: string;
  value: string;
}

export interface ProfileFormState {
  name: string;
  model: string;
  /** Always explicit. An entry with no `backend` resolves to claude, so the form shows claude and a
   *  save writes it out — a normalisation the resolver already applies at every agent start. */
  backend: ProfileBackend;
  /** '' means the field is not declared. */
  mode: string;
  provider: string;
  thinking: string;
  claudeBackend: ProfileClaudeBackend | '';
  extraOption: ProfileOptionRow[];
}

export function formStateFromEntry(entry: ConfigProfileEntry): ProfileFormState {
  return {
    name: entry.name,
    model: entry.model ?? '',
    backend: entry.backend ?? 'claude',
    mode: entry.mode ?? '',
    provider: entry.provider ?? '',
    thinking: entry.thinking ?? '',
    claudeBackend: entry.claudeBackend ?? '',
    extraOption: Object.entries(entry.extraOption).map(([key, value]) => ({ key, value })),
  };
}

export function emptyProfileForm(): ProfileFormState {
  return {
    name: '',
    model: '',
    backend: 'claude',
    mode: '',
    provider: '',
    thinking: '',
    claudeBackend: '',
    extraOption: [],
  };
}

/** Rows where both halves are blank are placeholders the editor added, not user input. */
export function usedOptionRows(rows: readonly ProfileOptionRow[]): ProfileOptionRow[] {
  return rows.filter((row) => row.key.trim() !== '' || row.value.trim() !== '');
}

function canonicalForm(form: ProfileFormState): string {
  return JSON.stringify({
    name: form.name.trim(),
    model: form.model.trim(),
    backend: form.backend,
    mode: form.mode.trim(),
    provider: form.provider.trim(),
    thinking: form.thinking,
    claudeBackend: form.claudeBackend,
    extraOption: usedOptionRows(form.extraOption)
      .map((row) => [row.key.trim(), row.value.trim()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  });
}

/** Both sides go through the same normalisation, so a stored entry never reads as dirty on open. */
export function isProfileFormDirty(form: ProfileFormState, entry: ConfigProfileEntry): boolean {
  return canonicalForm(form) !== canonicalForm(formStateFromEntry(entry));
}

export type ProfileFieldError =
  | 'name-required'
  | 'name-charset'
  | 'name-taken'
  | 'model-required'
  | 'mode-charset'
  | 'provider-required'
  | 'provider-charset'
  | 'thinking-level'
  | 'option-key-prefix'
  | 'option-key-duplicate'
  | 'option-value-required';

export interface ProfileFormErrors {
  name?: ProfileFieldError;
  model?: ProfileFieldError;
  mode?: ProfileFieldError;
  provider?: ProfileFieldError;
  thinking?: ProfileFieldError;
  extraOption?: ProfileFieldError;
}

export interface ProfileFormValidationOptions {
  mode: 'create' | 'update';
  /** Every name already in profiles.json — a create may not collide with one. */
  existingNames: readonly string[];
}

export function validateProfileForm(
  form: ProfileFormState,
  options: ProfileFormValidationOptions,
): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'name-required';
  else if (!SAFE_NAME_RE.test(name)) errors.name = 'name-charset';
  else if (options.mode === 'create' && options.existingNames.includes(name)) errors.name = 'name-taken';

  if (form.model.trim() === '') errors.model = 'model-required';

  const mode = form.mode.trim();
  if (mode !== '' && !SAFE_NAME_RE.test(mode)) errors.mode = 'mode-charset';

  // The server refuses a pi profile with no provider outright: the request protocol and gateway
  // endpoint group must be stated, never assumed.
  const provider = form.provider.trim();
  if (form.backend === 'pi' && provider === '') errors.provider = 'provider-required';
  else if (provider !== '' && !SAFE_NAME_RE.test(provider)) errors.provider = 'provider-charset';

  if (form.thinking !== '' && !THINKING_LEVELS[form.backend].includes(form.thinking)) {
    errors.thinking = 'thinking-level';
  }

  const rows = usedOptionRows(form.extraOption);
  const keys = rows.map((row) => row.key.trim());
  if (keys.some((key) => !key.startsWith('--'))) errors.extraOption = 'option-key-prefix';
  else if (new Set(keys).size !== keys.length) errors.extraOption = 'option-key-duplicate';
  else if (rows.some((row) => row.value.trim() === '')) errors.extraOption = 'option-value-required';

  return errors;
}

export function isProfileFormValid(errors: ProfileFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * An omitted field is DROPPED from the stored entry, not written empty — the draft is the complete
 * desired state for every field the editor can express. `extraEnv` and `fallback[]` are not among
 * them; the server carries those over from the stored entry.
 */
export function buildProfileDraft(form: ProfileFormState): ProfileDraftInput {
  const draft: ProfileDraftInput = { model: form.model.trim(), backend: form.backend };
  const mode = form.mode.trim();
  if (mode !== '') draft.mode = mode;
  const provider = form.provider.trim();
  if (provider !== '') draft.provider = provider;
  if (form.thinking !== '') draft.thinking = form.thinking;
  if (form.claudeBackend !== '') draft.claudeBackend = form.claudeBackend;
  const rows = usedOptionRows(form.extraOption);
  if (rows.length > 0) {
    draft.extraOption = Object.fromEntries(rows.map((row) => [row.key.trim(), row.value.trim()]));
  }
  return draft;
}

export function buildProfileCreateArgs(form: ProfileFormState): ProfilesCreateArgs {
  return { name: form.name.trim(), ...buildProfileDraft(form) };
}

export function buildProfileUpdateArgs(form: ProfileFormState): ProfilesUpdateArgs {
  return { name: form.name.trim(), ...buildProfileDraft(form) };
}
