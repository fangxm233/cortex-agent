export interface SlashCommand {
  /** Command id, also the text after the leading `/` (e.g. 'new'). */
  name: string;
  /** One-line description shown in the menu. */
  description: string;
}

// The palette mirrors the server's `!` command set (see orchestration/routing/commands). Names
// match their `!` command so App.handleCommand can forward `/<name> <args>` → `!<name> <args>`
// for any command without a bespoke client action. Only the interactive-meaningful commands are
// listed; Slack-only / pure-setup commands (sendFile, register, unregister, project-dir) are
// omitted but still usable by typing the raw `!` form.
export const SLASH_COMMANDS: SlashCommand[] = [
  // Session / conversation
  { name: 'new', description: 'New conversation — saves memory, then clears the view' },
  { name: 'newx', description: 'New conversation (fast) — skips the save, clears the view' },
  { name: 'resume', description: 'Resume a session — /resume for the picker, /resume <id> to jump' },
  { name: 'cancel', description: 'Cancel the current turn' },
  { name: 'restart', description: 'Restart the Cortex server (reconnects automatically)' },
  // Status / orientation
  { name: 'status', description: 'Show running executions and system status' },
  { name: 'orient', description: 'Project-wide status briefing — what to work on next' },
  { name: 'projects', description: 'List known projects' },
  // Cost / budget
  { name: 'cost', description: 'Show cost summary — /cost [today|week|month]' },
  { name: 'budget', description: 'Show or set the daily/monthly budget' },
  // Tasks / threads / scheduling
  { name: 'tasks', description: 'List or manage tasks — /tasks [args]' },
  { name: 'thread', description: 'Start or manage a thread — /thread <agent> <message>' },
  { name: 'agent', description: 'Run a one-off agent — /agent <name> <message>' },
  { name: 'schedule', description: 'Create or manage scheduled tasks — /schedule [args]' },
  { name: 'dispatch', description: 'Dispatch a task to the fleet — /dispatch <args>' },
  // Mode / model / profile
  { name: 'mode', description: 'Show the current runtime mode' },
  { name: 'model', description: 'Show or switch the model — /model [name]' },
  { name: 'backend', description: 'Show or switch the agent backend — /backend [name]' },
  { name: 'profile', description: 'Show or switch the agent profile — /profile [name]' },
  { name: 'skills', description: 'List available skills' },
  // Devices / GPU / logs
  { name: 'devices', description: 'List connected client devices' },
  { name: 'nvtop', description: 'GPU usage snapshot (nvtop) — /nvtop [device]' },
  { name: 'nvidia-smi', description: 'GPU status (nvidia-smi) — /nvidia-smi [device]' },
  { name: 'tail', description: 'Tail the daemon log — /tail [lines]' },
  // Misc
  { name: 'lang', description: 'Show or switch the UI language — /lang [zh|en]' },
  { name: 'mouse', description: 'Toggle mouse capture — off frees the mouse for text selection' },
  { name: 'help', description: 'Show available slash commands' },
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
