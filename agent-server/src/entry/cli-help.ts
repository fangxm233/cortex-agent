import { formatHelp } from '@core/cli-utils.js';
import { t } from '@core/i18n.js';

export function getInitHelp(): string {
  return [
    'Initialize Cortex data directory',
    '',
    'Usage: cortex init [--home <path>] [--gateway-config-dir <path>] [--force] [--answers <file>] [--json]',
    '',
    'Creates the CORTEX_HOME directory structure and asks for the language, interaction',
    'platform (Slack / Feishu), machine name, usage reporting and system service.',
    'Writes .env, copies default configs and generates mcp-config*.json, machines.json',
    'and agent-state.json. It then detects provider logins, offers to log in, and sets',
    'up gateway routes, the default model and favorites.',
    '',
    'Options:',
    '  --home <path>                Set CORTEX_HOME (default: $CORTEX_HOME or ~/.cortex/)',
    '  --gateway-config-dir <path>  Gateway config output directory (default: ~/.aistatus/)',
    '  --force                      Overwrite existing configs (.env, budget.json, agent-state.json, etc.)',
    '  --answers <file>             Read answers from a JSON file instead of prompting; omitted fields use defaults',
    '  --json                       Print NDJSON progress events on stdout and send human output to stderr',
    '  --help, -h                   Show this help',
    '',
    'With --answers or --json, init does not prompt or start provider login; it reports',
    'credential status and can finish before any provider is set up.',
    '',
    'Examples:',
    '  cortex init',
    '  cortex init --home /data/cortex',
    '  cortex init --answers answers.json --json',
  ].join('\n');
}

export function getSetupGatewayHelp(): string {
  return [
    'Auto-detect Claude Code / PI configurations and generate gateway.yaml + models.json',
    '',
    'Usage: cortex setup-gateway [--dry-run] [--output-dir <path>]',
    '',
    'Discovers backend endpoints from local Claude Code and PI configs, then',
    'writes ~/.aistatus/gateway.yaml (with backup) and $CORTEX_HOME/config/models.json.',
    'Without flags, this command writes files in place.',
    '',
    'Options:',
    '  --dry-run               Print the generated gateway.yaml to stdout without writing anything',
    '  --output-dir <path>     Write gateway.yaml and models.json under <path> instead of the defaults',
    '  --help, -h              Show this help',
  ].join('\n');
}

export function getTuiHelp(): string {
  return [
    'Start the Cortex TUI (terminal UI) client',
    '',
    'Usage: cortex tui [options]',
    '',
    'Connects to a running Cortex daemon via WebSocket and opens',
    'a terminal-based chat interface.',
    '',
    'Options:',
    '  --resume              Open the resume-session picker on connect',
    '  --project <id>        Start a fresh session in the named project',
    '  --port <n>            Override TUI port (default: 3003, or CORTEX_TUI_PORT)',
    '  --help, -h            Show this help',
  ].join('\n');
}

export function getUiHelp(): string {
  return formatHelp({
    name: 'cortex ui',
    description: 'Manage the local Web UI endpoint used by the Cortex desktop app',
    usage: 'cortex ui enable [--port <port>] [--home <path>] [--json]',
    commands: [
      { name: 'enable', description: 'Turn on the loopback Web UI endpoint and print how to reach it' },
    ],
    options: [
      { flag: '--port <port>', description: 'TCP port to serve the Web UI on', default: 'the configured CORTEX_UI_PORT, else 3004' },
      { flag: '--home <path>', description: 'CORTEX_HOME to configure', default: '$CORTEX_HOME or ~/.cortex' },
      { flag: '--json', description: 'Print the endpoint, token and change state as JSON' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Enable the endpoint, keeping the configured port', command: 'cortex ui enable' },
      { description: 'Serve on another port', command: 'cortex ui enable --port 4000' },
      { description: 'Machine-readable output for the desktop setup flow', command: 'cortex ui enable --json' },
    ],
  });
}

export function getPathHelp(): string {
  return formatHelp({
    name: 'cortex path',
    description: 'Make this install\'s commands (cortex, cortex-signal, …) available in new terminals',
    usage: 'cortex path <install|remove|status> [--home <path>] [--dry-run] [--json]',
    commands: [
      {
        name: 'install',
        description: 'Write launchers that use this install\'s Node into <home>/runtime/bin and put that '
          + 'directory on PATH (shell profiles on Linux/macOS, the user Path on Windows)',
      },
      { name: 'remove', description: 'Delete the launchers and undo the PATH change' },
      { name: 'status', description: 'Show whether the launchers exist, are current, and are on PATH' },
    ],
    options: [
      { flag: '--home <path>', description: 'CORTEX_HOME the launchers belong to', default: '$CORTEX_HOME or ~/.cortex' },
      { flag: '--dry-run', description: 'Report what install or remove would change and change nothing' },
      { flag: '--json', description: 'Print the result as JSON' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Add cortex to new terminals', command: 'cortex path install' },
      { description: 'Preview the change', command: 'cortex path install --dry-run --json' },
      { description: 'Check the current state', command: 'cortex path status' },
      { description: 'Undo it', command: 'cortex path remove' },
    ],
  });
}

export function getClientHelp(): string {
  return formatHelp({
    name: 'cortex client',
    description: 'Manage the cortex-client installs on remote machines',
    usage: 'cortex client remove --device <name> [--keep-remote] [--dry-run] [--home <path>]',
    commands: [
      {
        name: 'remove',
        description: 'Unregister a machine from machines.json, stop and uninstall its client over SSH, '
          + 'and drop its runtime state',
      },
    ],
    options: [
      { flag: '--device <name>', description: 'Machine name as registered in machines.json (required)' },
      { flag: '--keep-remote', description: 'Only unregister locally; leave the remote process and files alone' },
      { flag: '--dry-run', description: 'Print what would be removed as JSON and change nothing' },
      { flag: '--home <path>', description: 'CORTEX_HOME of the server', default: '$CORTEX_HOME or ~/.cortex' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Preview the removal', command: 'cortex client remove --device trainer --dry-run' },
      { description: 'Remove a machine and uninstall its client', command: 'cortex client remove --device trainer' },
      { description: 'Unregister a machine that no longer exists', command: 'cortex client remove --device trainer --keep-remote' },
    ],
  });
}

export function getMemoryHelp(): string {
  return formatHelp({
    name: 'cortex memory',
    description: 'Project memory under $CORTEX_HOME/context/projects (experiments/, knowledge/, patterns/).\n'
      + 'regen rewrites only the generated index.md files; the EXP/K/PAT files are never modified. Output is JSON.',
    usage: 'cortex memory <command> [--project <name>]... [options]',
    commands: [
      { name: 'regen', description: 'Rebuild experiments/knowledge/patterns index.md from frontmatter and the access log' },
      { name: 'consolidate', description: 'Report contradictions, stale entries, anti-pattern signals and consolidation candidates' },
    ],
    options: [
      { flag: '--project <name>', description: 'Limit to one project; repeat for several', default: 'every project with memory directories' },
      { flag: '--text', description: 'consolidate: print a human-readable summary instead of JSON' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Rebuild every index', command: 'cortex memory regen' },
      { description: 'Rebuild one project\'s indexes', command: 'cortex memory regen --project wm-align' },
      { description: 'Lifecycle report for all projects', command: 'cortex memory consolidate --text' },
      { description: 'Lifecycle report as JSON for one project', command: 'cortex memory consolidate --project wm-align' },
    ],
  });
}

export function getScheduleHelp(): string {
  return formatHelp({
    name: 'cortex schedule',
    description: 'Manage scheduled tasks. Each fire opens a new session in the schedule\'s project and sends it the message.\n'
      + 'Changes land in schedules.json; a running daemon picks them up within a second. Output is JSON.',
    usage: 'cortex schedule <command> [<id>] [options]',
    commands: [
      { name: 'list', description: 'List schedules (--project to filter)' },
      { name: 'get <id>', description: 'Show one schedule' },
      { name: 'add --type <type>', description: 'Create a schedule' },
      { name: 'edit <id>', description: 'Change message, project, model, thinking, pre-check or timing (the type is fixed)' },
      { name: 'pause <id>', description: 'Pause a recurring schedule' },
      { name: 'resume <id>', description: 'Resume a paused schedule' },
      { name: 'remove <id>', description: 'Delete a schedule (--dry-run to preview)' },
    ],
    options: [
      { flag: '--type <type>', description: 'add: interval | daily | weekly | once' },
      { flag: '--interval <duration>', description: 'interval: repeat period, e.g. 30m, 2h, 1d' },
      { flag: '--time <HH:MM>', description: 'daily/weekly: time of day, 24-hour, server local time' },
      { flag: '--day <day>', description: 'weekly: sun..sat or 0-6' },
      { flag: '--delay <duration>', description: 'once: fire this long from now, e.g. 90m, 2h' },
      { flag: '--message <text|->', description: 'Prompt for the fired session; "-" reads stdin' },
      { flag: '--project <id>', description: 'Project the fired session belongs to', default: 'general' },
      { flag: '--model [provider/]model', description: 'Model to run', default: 'the default model' },
      { flag: '--thinking <level>', description: 'Thinking level for the selected model' },
      { flag: '--pre-check <cmd>', description: 'Shell gate run before each fire; non-zero exit skips it' },
      { flag: '--idempotency-key <key>', description: 'add: return the schedule already created with this key' },
      { flag: '--dry-run', description: 'remove: show what would be removed' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Every 30 minutes in a project', command: 'cortex schedule add --type interval --interval 30m --project nimbus --message "Check GPU usage on lab2 and report a one-line summary"' },
      { description: 'Every day at 09:00', command: 'cortex schedule add --type daily --time 09:00 --message "Summarize yesterday\'s sessions"' },
      { description: 'Every Monday at 21:00', command: 'cortex schedule add --type weekly --day mon --time 21:00 --message "Weekly review"' },
      { description: 'Once, two hours from now, prompt from stdin', command: 'echo "Check training run r42 on lab2" | cortex schedule add --type once --delay 2h --message -' },
      { description: 'List one project\'s schedules', command: 'cortex schedule list --project nimbus' },
      { description: 'Move a daily schedule to 10:30', command: 'cortex schedule edit a1b2c3d4 --time 10:30' },
      { description: 'Preview a removal', command: 'cortex schedule remove a1b2c3d4 --dry-run' },
    ],
  });
}

function getCliCommands() {
  return [
    { name: 'init', description: 'Initialize CORTEX_HOME directory with configs and API keys' },
    { name: 'start', description: 'Start the Cortex server (node dist/entry/app.js)' },
    { name: 'daemon', description: 'Start daemon mode with file watching and auto-restart' },
    { name: 'daemon stop', description: 'Stop the running daemon (SIGTERM) and the local client it launched' },
    { name: 'daemon status', description: 'Check daemon + child status (PID, uptime)' },
    { name: 'daemon restart', description: 'Graceful restart — signal daemon to drain and respawn app.js' },
    { name: 'daemon restart --hard', description: 'Hard restart — send SIGTERM directly to app.js (daemon auto-recovers)' },
    { name: 'daemon restart --force', description: 'Force restart — send SIGKILL immediately to app.js' },
    { name: 'daemon restart-self', description: 'Stop and restart the daemon process itself' },
    { name: 'restart', description: 'Legacy alias for daemon restart (touches $STORE_DIR/.restart)' },
    { name: 'install latest', description: 'Install the latest version of Cortex from npm' },
    { name: 'config', description: 'Show resolved paths and initialization status' },
    { name: 'doctor', description: 'Health-check the install (runtime, login, platform, gateway); --fix to repair' },
    { name: 'auth status', description: t('cmd.auth.cli.statusDescription') },
    { name: 'feishu', description: 'Manage Feishu user-identity login (login / status / logout)' },
    { name: 'setup-gateway', description: 'Auto-detect Claude/PI configs and generate gateway.yaml + models.json' },
    { name: 'ui enable', description: 'Enable the local Web UI endpoint the desktop app connects to' },
    { name: 'client remove', description: 'Unregister a remote machine and uninstall its cortex-client' },
    { name: 'path install', description: 'Make cortex available in new terminals (remove / status to undo or check)' },
    { name: 'schedule', description: 'List, add, edit, pause, resume and remove scheduled tasks' },
    { name: 'memory', description: 'Rebuild project memory indexes; report knowledge lifecycle findings' },
    { name: 'tui', description: 'Start the Terminal UI (TUI) client for local interaction' },
  ];
}

function getCliExamples() {
  return [
    { description: 'Interactive init', command: 'cortex init' },
    { description: 'Init to custom directory', command: 'cortex init --home /tmp/my-cortex' },
    { description: 'Show resolved paths', command: 'cortex config' },
    { description: 'Health-check the install', command: 'cortex doctor' },
    { description: t('cmd.auth.cli.exampleSummary'), command: 'cortex auth status' },
    { description: t('cmd.auth.cli.exampleJson'), command: 'cortex auth status --json' },
    { description: 'Diagnose and auto-repair', command: 'cortex doctor --fix' },
    { description: 'Re-generate gateway config', command: 'cortex setup-gateway' },
    { description: 'Enable the local Web UI endpoint', command: 'cortex ui enable' },
    { description: 'Remove a remote machine and its client', command: 'cortex client remove --device trainer' },
    { description: 'Add cortex to new terminals', command: 'cortex path install' },
    { description: 'List scheduled tasks', command: 'cortex schedule list' },
    { description: 'Rebuild every project memory index', command: 'cortex memory regen' },
    { description: 'Start the server', command: 'cortex start' },
    { description: 'Stop the daemon', command: 'cortex daemon stop' },
    { description: 'Check daemon status', command: 'cortex daemon status' },
    { description: 'Graceful restart', command: 'cortex daemon restart' },
    { description: 'Hard restart app.js', command: 'cortex daemon restart --hard' },
    { description: 'Restart daemon itself', command: 'cortex daemon restart-self' },
  ];
}

export function getCliHelp(): string {
  return formatHelp({
    name: 'cortex',
    description: 'Cortex CLI — server management and initialization',
    usage: 'cortex <command> [options]',
    commands: getCliCommands(),
    options: [{ flag: '--help, -h', description: 'Show this help' }],
    examples: getCliExamples(),
  });
}

export function getAuthHelp(): string {
  return formatHelp({
    name: 'cortex auth',
    description: t('cmd.auth.cli.description'),
    usage: 'cortex auth <status|login|provider> [options]',
    commands: [
      { name: 'status', description: t('cmd.auth.cli.statusDescription') },
      { name: 'login', description: t('init.auth.loginDescription') },
      { name: 'provider', description: t('provider.cli.description') },
    ],
    options: [
      { flag: '--json', description: t('cmd.auth.cli.jsonDescription') },
      { flag: '--help, -h', description: t('cmd.auth.cli.helpDescription') },
    ],
    examples: [
      { description: t('cmd.auth.cli.exampleSummary'), command: 'cortex auth status' },
      { description: t('cmd.auth.cli.exampleJson'), command: 'cortex auth status --json' },
      { description: t('provider.cli.exampleList'), command: 'cortex auth provider list' },
    ],
    labels: {
      usage: t('cmd.auth.cli.helpUsage'),
      commands: t('cmd.auth.cli.helpCommands'),
      options: t('cmd.auth.cli.helpOptions'),
      examples: t('cmd.auth.cli.helpExamples'),
    },
  });
}
