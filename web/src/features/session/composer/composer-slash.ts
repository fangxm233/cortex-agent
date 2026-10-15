import { SLASH_COMMANDS, type SlashVocab } from './chat-content';

export interface SlashModelOption {
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
  | { type: 'model'; modelName: string }
  | { type: 'settings' }
  | { type: 'usage' };

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
  usageDisabled?: boolean;
}

export interface SlashActionHandlers {
  onNew: () => void;
  onCancel: () => void;
  onCompact: () => void;
  onModel: (name: string) => void;
  onSettings: () => void;
  onUsage: () => void;
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
    usage: { type: 'usage' },
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
  if (action.type === 'model') return false;
  return !!availability[`${action.type}Disabled`];
}

/** A skill invocation resolves to `none`: it is sent to the agent as typed. */
export function resolveSlashInput(
  text: string,
  models: SlashModelOption[],
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
  if (parsed.command === 'model') return resolveModel(parsed, models);
  const action = actionFor(parsed.command);
  if (parsed.args || !action) return { kind: 'invalid' };
  return isActionDisabled(action, availability) ? { kind: 'disabled' } : { kind: 'action', action };
}

function resolveModel(parsed: ParsedSlash, models: SlashModelOption[]): SlashResolution {
  if (!parsed.hasArgsSeparator || !parsed.args) return { kind: 'incomplete' };
  if (/\s/.test(parsed.args)) return { kind: 'invalid' };
  const model = models.find((item) => item.name.toLowerCase() === parsed.args.toLowerCase());
  if (!model) return { kind: 'invalid' };
  if (model.disabled) return { kind: 'disabled' };
  return { kind: 'action', action: { type: 'model', modelName: model.name } };
}

function modelSuggestions(query: string, models: SlashModelOption[], L: SlashVocab): SlashSuggestion[] {
  return models
    .filter((model) => model.name.toLowerCase().startsWith(query))
    .map((model) => ({
      command: `/model ${model.name}`,
      description: model.detail ?? L.chatSlashModel,
      action: { type: 'model' as const, modelName: model.name },
      disabled: model.disabled ?? false,
    }));
}

/** Local commands first, then the conversation's skills; picking a skill puts its command in. */
export function buildSlashSuggestions(
  text: string,
  models: SlashModelOption[],
  L: SlashVocab,
  availability: SlashAvailability = {},
  skills: readonly SlashSkillOption[] = [],
): SlashSuggestion[] {
  const parsed = parseSlashInput(text);
  if (!parsed) return [];
  if (parsed.command === 'model' && parsed.hasArgsSeparator) {
    return modelSuggestions(parsed.args.toLowerCase(), models, L);
  }
  if (parsed.hasArgsSeparator) return [];
  const local = SLASH_COMMANDS
    .filter((item) => item.cmd.slice(1).startsWith(parsed.command))
    .map((item) => ({
      command: item.cmd,
      description: L[item.desc],
      action: item.cmd === '/model' ? null : actionFor(item.cmd.slice(1)),
      disabled: item.cmd === '/model'
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
  if (action.type === 'model') {
    handlers.onModel(action.modelName);
    return;
  }
  const actions = {
    new: handlers.onNew,
    cancel: handlers.onCancel,
    compact: handlers.onCompact,
    settings: handlers.onSettings,
    usage: handlers.onUsage,
  };
  actions[action.type]();
}
