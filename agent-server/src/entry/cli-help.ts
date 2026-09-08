// input:  shared CLI formatter and localized auth vocabulary
// output: CLI help including localized auth login discovery
// pos:    Cortex CLI help-family definitions
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { formatHelp } from '@core/cli-utils.js';
import { t } from '@core/i18n.js';

export function getInitHelp(): string {
  return [
    'Initialize Cortex data directory',
    '',
    'Usage: cortex init [--home <path>] [--gateway-config-dir <path>]',
    '',
    'Creates the CORTEX_HOME directory structure, prompts for backends,',
    'interaction platform (Slack / Feishu), gateway usage, and system service.',
    'Generates .env with platform tokens, copies default configs, and',
    'auto-generates mcp-config.json and mode.json.',
    '',
    'Options:',
    '  --home <path>               Set CORTEX_HOME (default: $CORTEX_HOME or ~/.cortex/)',
    '  --gateway-config-dir <path>  Gateway config output directory (default: ~/.aistatus/)',
    '  --force                     Overwrite existing configs (.env, budget.json, mode.json, etc.)',
    '  --help, -h                  Show this help',
  ].join('\n');
}

export function getSetupGatewayHelp(): string {
  return [
    'Auto-detect Claude Code / PI configurations and generate gateway.yaml + profiles.json',
    '',
    'Usage: cortex setup-gateway [--dry-run] [--output-dir <path>]',
    '',
    'Discovers backend endpoints from local Claude Code and PI configs, then',
    'writes ~/.aistatus/gateway.yaml (with backup) and $CORTEX_HOME/config/profiles.json.',
    'Without flags, this command writes files in place.',
    '',
    'Options:',
    '  --dry-run               Print the generated gateway.yaml to stdout without writing anything',
    '  --output-dir <path>     Write gateway.yaml and profiles.json under <path> instead of the defaults',
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
      { flag: '--port <port>', description: 'TCP port to serve the Web UI on', default: '3004' },
      { flag: '--home <path>', description: 'CORTEX_HOME to configure', default: '$CORTEX_HOME or ~/.cortex' },
      { flag: '--json', description: 'Print the endpoint, token and change state as JSON' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Enable the endpoint on the default port', command: 'cortex ui enable' },
      { description: 'Serve on another port', command: 'cortex ui enable --port 4000' },
      { description: 'Machine-readable output for the desktop setup flow', command: 'cortex ui enable --json' },
    ],
  });
}

function getCliCommands() {
  return [
    { name: 'init', description: 'Initialize CORTEX_HOME directory with configs and API keys' },
    { name: 'start', description: 'Start the Cortex server (node dist/entry/app.js)' },
    { name: 'daemon', description: 'Start daemon mode with file watching and auto-restart' },
    { name: 'daemon stop', description: 'Stop the running daemon gracefully (SIGTERM)' },
    { name: 'daemon status', description: 'Check daemon + child status (PID, uptime)' },
    { name: 'daemon restart', description: 'Graceful restart — signal daemon to drain and respawn app.js' },
    { name: 'daemon restart --hard', description: 'Hard restart — send SIGTERM directly to app.js (daemon auto-recovers)' },
    { name: 'daemon restart --force', description: 'Force restart — send SIGKILL immediately to app.js' },
    { name: 'daemon restart-self', description: 'Stop and restart the daemon process itself' },
    { name: 'restart', description: 'Legacy alias for daemon restart (touches $STORE_DIR/.restart)' },
    { name: 'task', description: 'Task system CLI (delegate to cortex-task)' },
    { name: 'install latest', description: 'Install the latest version of Cortex from npm' },
    { name: 'config', description: 'Show resolved paths and initialization status' },
    { name: 'doctor', description: 'Health-check the install (runtime, login, platform, gateway); --fix to repair' },
    { name: 'auth status', description: t('cmd.auth.cli.statusDescription') },
    { name: 'feishu', description: 'Manage Feishu user-identity login (login / status / logout)' },
    { name: 'setup-gateway', description: 'Auto-detect Claude/PI configs and generate gateway.yaml + profiles.json' },
    { name: 'ui enable', description: 'Enable the local Web UI endpoint the desktop app connects to' },
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
