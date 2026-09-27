import { t } from '../core/i18n.js';

export interface SlashCommand {
  /** Command id, also the text after the leading `/` (e.g. 'new'). */
  name: string;
  /** One-line description shown in the menu. */
  description: string;
}

// Descriptions are getters (tui.slash.<name>) so the palette follows the active locale instead of
// freezing whatever language was set when this module loaded.
function cmd(name: string): SlashCommand {
  return { name, get description() { return t(`tui.slash.${name}`); } };
}

// The palette mirrors the server's `!` command set (see orchestration/routing/commands). Names
// match their `!` command so App.handleCommand can forward `/<name> <args>` → `!<name> <args>`
// for any command without a bespoke client action. Only the interactive-meaningful commands are
// listed; Slack-only / pure-setup commands (sendFile, register, unregister, project-dir) are
// omitted but still usable by typing the raw `!` form.
export const SLASH_COMMANDS: SlashCommand[] = [
  // Session / conversation
  cmd('new'),
  cmd('newx'),
  cmd('resume'),
  cmd('cancel'),
  cmd('restart'),
  // Status / orientation
  cmd('status'),
  cmd('orient'),
  cmd('projects'),
  // Cost / budget
  cmd('cost'),
  cmd('budget'),
  // Tasks / threads / scheduling
  cmd('tasks'),
  cmd('thread'),
  cmd('agent'),
  cmd('schedule'),
  cmd('dispatch'),
  // Mode / model / profile
  cmd('mode'),
  cmd('model'),
  cmd('backend'),
  cmd('profile'),
  cmd('skills'),
  // Devices / GPU / logs
  cmd('devices'),
  cmd('nvtop'),
  cmd('nvidia-smi'),
  cmd('tail'),
  // Misc
  cmd('lang'),
  cmd('mouse'),
  cmd('help'),
];

export interface ParsedSlash {
  /** True when the text is a slash invocation (starts with '/'). */
  isSlash: boolean;
  /** The command token after '/', lowercased, up to the first space. */
  query: string;
  /** Everything after the first space, trimmed (command arguments). */
  args: string;
}

/** Parse input-box text into its slash parts. Non-slash text yields isSlash:false. */
export function parseSlashInput(text: string): ParsedSlash {
  if (!text.startsWith('/')) return { isSlash: false, query: '', args: '' };
  const rest = text.slice(1);
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx === -1) {
    return { isSlash: true, query: rest.toLowerCase(), args: '' };
  }
  return {
    isSlash: true,
    query: rest.slice(0, spaceIdx).toLowerCase(),
    args: rest.slice(spaceIdx + 1).trim(),
  };
}

/** Commands whose name starts with `query` (case-insensitive). Empty query → all. */
export function filterSlashCommands(query: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.toLowerCase();
  if (q.length === 0) return commands.slice();
  return commands.filter(c => c.name.startsWith(q));
}

/** Exact command match for `query`, or null. */
export function findSlashCommand(query: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand | null {
  const q = query.toLowerCase();
  return commands.find(c => c.name === q) ?? null;
}
