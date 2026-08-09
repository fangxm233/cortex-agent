// input:  composer text, UI shortcut catalog and profile options
// output: local slash suggestions, resolutions and action dispatch
// pos:    Shared desktop/mobile slash-command model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { SLASH_COMMANDS } from './chat-content';

export interface SlashProfileOption {
  name: string;
  detail?: string;
  disabled?: boolean;
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

export interface SlashSuggestion {
  command: string;
  description: string;
  action: SlashAction | null;
  disabled: boolean;
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

function isActionDisabled(action: SlashAction, availability: SlashAvailability): boolean {
  if (action.type === 'profile') return false;
  return !!availability[`${action.type}Disabled`];
}

export function resolveSlashInput(
  text: string,
  profiles: SlashProfileOption[],
  availability: SlashAvailability = {},
): SlashResolution {
  const parsed = parseSlashInput(text);
  if (!parsed) return { kind: 'none' };
  const known = SLASH_COMMANDS.some((item) => item.cmd === `/${parsed.command}`);
  const prefix = SLASH_COMMANDS.some((item) => item.cmd.slice(1).startsWith(parsed.command));
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

function profileSuggestions(query: string, profiles: SlashProfileOption[]): SlashSuggestion[] {
  return profiles
    .filter((profile) => profile.name.toLowerCase().startsWith(query))
    .map((profile) => ({
      command: `/profile ${profile.name}`,
      description: profile.detail ?? 'Switch this session profile',
      action: { type: 'profile' as const, profileName: profile.name },
      disabled: profile.disabled ?? false,
    }));
}

export function buildSlashSuggestions(
  text: string,
  profiles: SlashProfileOption[],
  availability: SlashAvailability = {},
): SlashSuggestion[] {
  const parsed = parseSlashInput(text);
  if (!parsed) return [];
  if (parsed.command === 'profile' && parsed.hasArgsSeparator) {
    return profileSuggestions(parsed.args.toLowerCase(), profiles);
  }
  if (parsed.hasArgsSeparator) return [];
  return SLASH_COMMANDS
    .filter((item) => item.cmd.slice(1).startsWith(parsed.command))
    .map((item) => ({
      command: item.cmd,
      description: item.desc,
      action: item.cmd === '/profile' ? null : actionFor(item.cmd.slice(1)),
      disabled: item.cmd === '/profile'
        ? false
        : isActionDisabled(actionFor(item.cmd.slice(1))!, availability),
    }));
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
