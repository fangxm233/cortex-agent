import { SLASH_COMMANDS, type SlashVocab } from './chat-content';

export interface SlashProfileOption {
  name: string;
  detail?: string;
  disabled?: boolean;
}

/** A skill the conversation loads. `command` is what follows `/` to invoke it on this backend
 *  (`cortex-coder:develop`, `skill:develop`); `name` alone is also matched while typing. */
export interface SlashSkillOption {
  name: string;
  command: string;
  description: string;
}

export type SlashAction =
  | { type: 'new' }
  | { type: 'cancel' }
  | { type: 'compact' }
  | { type: 'profile'; profileName: string }
  | { type: 'settings' };

export type SlashResolution =
  | { kind: 'none' }
  | { kind: 'incomplete' }
  | { kind: 'invalid' }
  | { kind: 'disabled' }
  | { kind: 'action'; action: SlashAction };

export function slashFeedbackKey(resolution: SlashResolution) {
  const keys = {
    none: null,
    action: null,
    invalid: 'wbSlashInvalid',
    incomplete: 'wbSlashIncomplete',
    disabled: 'wbSlashDisabled',
  } as const;
  return keys[resolution.kind];
}

export interface SlashSuggestion {
  command: string;
  description: string;
  action: SlashAction | null;
  disabled: boolean;
  /** A skill row: picking it puts the command in, and picking it again sends it. */
  skill?: boolean;
}

export interface SlashAvailability {
  newDisabled?: boolean;
  cancelDisabled?: boolean;
  compactDisabled?: boolean;
  settingsDisabled?: boolean;
}

export interface SlashActionHandlers {
  onNew: () => void;
  onCancel: () => void;
  onCompact: () => void;
  onProfile: (name: string) => void;
  onSettings: () => void;
}

interface ParsedSlash {
  command: string;
  args: string;
  hasArgsSeparator: boolean;
}

function parseSlashInput(text: string): ParsedSlash | null {
  const value = text.trimStart();
  if (!value.startsWith('/')) return null;
  const body = value.slice(1);
  const separator = body.search(/\s/);
  if (separator < 0) return { command: body.toLowerCase(), args: '', hasArgsSeparator: false };
  return {
    command: body.slice(0, separator).toLowerCase(),
    args: body.slice(separator + 1).trim(),
    hasArgsSeparator: true,
  };
}

function actionFor(command: string): SlashAction | null {
  const actions: Record<string, SlashAction> = {
    new: { type: 'new' }, cancel: { type: 'cancel' }, compact: { type: 'compact' }, settings: { type: 'settings' },
  };
  return actions[command] ?? null;
}

function findSkill(command: string, skills: readonly SlashSkillOption[]): SlashSkillOption | undefined {
  return skills.find((skill) => skill.command.toLowerCase() === command || skill.name.toLowerCase() === command);
}

function skillMatches(query: string, skill: SlashSkillOption): boolean {
  return skill.command.toLowerCase().startsWith(query) || skill.name.toLowerCase().startsWith(query);
}

function isActionDisabled(action: SlashAction, availability: SlashAvailability): boolean {
  if (action.type === 'profile') return false;
  return !!availability[`${action.type}Disabled`];
}

/** A skill invocation resolves to `none`: it is sent to the agent as typed. */
export function resolveSlashInput(
  text: string,
  profiles: SlashProfileOption[],
  availability: SlashAvailability = {},
  skills: readonly SlashSkillOption[] = [],
): SlashResolution {
  const parsed = parseSlashInput(text);
  if (!parsed) return { kind: 'none' };
  const known = SLASH_COMMANDS.some((item) => item.cmd === `/${parsed.command}`);
  if (!known && findSkill(parsed.command, skills)) return { kind: 'none' };
  const prefix = SLASH_COMMANDS.some((item) => item.cmd.slice(1).startsWith(parsed.command))
    || skills.some((skill) => skillMatches(parsed.command, skill));
  if (!known) return prefix && !parsed.hasArgsSeparator ? { kind: 'incomplete' } : { kind: 'invalid' };
  if (parsed.command === 'profile') return resolveProfile(parsed, profiles);
  const action = actionFor(parsed.command);
  if (parsed.args || !action) return { kind: 'invalid' };
  return isActionDisabled(action, availability) ? { kind: 'disabled' } : { kind: 'action', action };
}

function resolveProfile(parsed: ParsedSlash, profiles: SlashProfileOption[]): SlashResolution {
  if (!parsed.hasArgsSeparator || !parsed.args) return { kind: 'incomplete' };
  if (/\s/.test(parsed.args)) return { kind: 'invalid' };
  const profile = profiles.find((item) => item.name.toLowerCase() === parsed.args.toLowerCase());
  if (!profile) return { kind: 'invalid' };
  if (profile.disabled) return { kind: 'disabled' };
  return { kind: 'action', action: { type: 'profile', profileName: profile.name } };
}

function profileSuggestions(query: string, profiles: SlashProfileOption[], L: SlashVocab): SlashSuggestion[] {
  return profiles
    .filter((profile) => profile.name.toLowerCase().startsWith(query))
    .map((profile) => ({
      command: `/profile ${profile.name}`,
      description: profile.detail ?? L.chatSlashProfile,
      action: { type: 'profile' as const, profileName: profile.name },
      disabled: profile.disabled ?? false,
    }));
}

/** Local commands first, then the conversation's skills; picking a skill puts its command in. */
export function buildSlashSuggestions(
  text: string,
  profiles: SlashProfileOption[],
  L: SlashVocab,
  availability: SlashAvailability = {},
  skills: readonly SlashSkillOption[] = [],
): SlashSuggestion[] {
  const parsed = parseSlashInput(text);
  if (!parsed) return [];
  if (parsed.command === 'profile' && parsed.hasArgsSeparator) {
    return profileSuggestions(parsed.args.toLowerCase(), profiles, L);
  }
  if (parsed.hasArgsSeparator) return [];
  const local = SLASH_COMMANDS
    .filter((item) => item.cmd.slice(1).startsWith(parsed.command))
    .map((item) => ({
      command: item.cmd,
      description: L[item.desc],
      action: item.cmd === '/profile' ? null : actionFor(item.cmd.slice(1)),
      disabled: item.cmd === '/profile'
        ? false
        : isActionDisabled(actionFor(item.cmd.slice(1))!, availability),
    }));
  const skillRows = skills
    .filter((skill) => skillMatches(parsed.command, skill))
    .map((skill) => ({
      command: `/${skill.command}`, description: skill.description, action: null, disabled: false, skill: true,
    }));
  return [...local, ...skillRows];
}

export function runSlashAction(action: SlashAction, handlers: SlashActionHandlers): void {
  if (action.type === 'profile') {
    handlers.onProfile(action.profileName);
    return;
  }
  const actions = {
    new: handlers.onNew,
    cancel: handlers.onCancel,
    compact: handlers.onCompact,
    settings: handlers.onSettings,
  };
  actions[action.type]();
}
