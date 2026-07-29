// input:  defaults, filesystem, MCP builders, platform setup
// output: runInit and initialization helpers
// pos:    Initializes Cortex home and runtime configuration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { stdin as processStdin } from 'process';
import * as clack from '@clack/prompts';
import * as yaml from 'yaml';
import {
  buildCoreConfig,
  buildFullConfig,
  buildManagerQaConfig,
  buildTasksConfig,
  buildThreadConfig,
  buildTuiConfig,
} from '@core/config-generator.js';
import { discoverEndpoints, writeMergedGatewayYaml, validateProfilesAgainstGateway } from '@core/gateway-generator.js';
import { generateProfiles, mergeProfilesJson, writeProfilesJson, listChoices } from '@core/profile-generator.js';
import { mergeThreadTemplates } from '@domain/threads/index.js';
import type { ModelChoice } from '@core/profile-generator.js';
import { createLogger } from '@core/log.js';
import { INSTALL_ROOT, DEFAULTS_DIR } from '@core/utils.js';
import { t, setLocale, normalizeLocale, detectSystemLocale, type Locale } from '../core/i18n.js';
import { cmdFeishu, type CliResult } from './feishu-login.js';

// ─── Path computation (DATA_DIR resolved locally to support --home override) ──

const log = createLogger('init');

// MODULE_DIR kept for any consumers that still derive paths locally; the canonical roots
// (INSTALL_ROOT, DEFAULTS_DIR) come from @core/paths via @core/utils.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface InitPaths {
  DATA_DIR: string;
  CONFIG_DIR: string;
  STORE_DIR: string;
  CONTEXT_DIR: string;
  PROJECTS_DIR: string;
  WORKSPACE_DIR: string;
}

/** Resolve DATA_DIR from --home arg, $CORTEX_HOME env, or ~/.cortex/ default. */
export function getResolvedPaths(homeDir?: string): InitPaths {
  const dataDir = homeDir
    ? path.resolve(homeDir)
    : process.env.CORTEX_HOME
      ? path.resolve(process.env.CORTEX_HOME)
      : path.join(os.homedir(), '.cortex');

  const contextDir = path.join(dataDir, 'context');
  return {
    DATA_DIR: dataDir,
    CONFIG_DIR: path.join(dataDir, 'config'),
    STORE_DIR: path.join(dataDir, 'data'),
    CONTEXT_DIR: contextDir,
    PROJECTS_DIR: process.env.CORTEX_PROJECTS_DIR
      ? path.resolve(process.env.CORTEX_PROJECTS_DIR)
      : path.join(contextDir, 'projects'),
    WORKSPACE_DIR: path.join(dataDir, 'tmp'),
  };
}

// ─── Types ──────────────────────────────────────────────────────

export type InitBackend = 'claude' | 'pi';
/** A single selectable interaction platform. */
export type PlatformChoice = 'slack' | 'feishu';
/** @deprecated single-platform alias kept for back-compat; use PlatformChoice[]. */
export type InitPlatform = PlatformChoice | 'none';

export interface SlackInitConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
}

export interface FeishuInitConfig {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  /** Identity for MCP document operations: 'bot' (default) or the operator's 'user' account. */
  authMode?: 'bot' | 'user';
}

export interface GatewayUsageConfig {
  enabled: boolean;
  name?: string;
  org?: string;
  email?: string;
}

export interface InitAnswers {
  /** UI language for system-generated messages. Persisted to config/preferences.json. */
  lang: Locale;
  backends: InitBackend[];
  machineName: string;
  gpuCount: number;
  /** Selected interaction platforms (multi-select). Empty array = no platform (manual/skip). */
  platforms: PlatformChoice[];
  slackConfig?: SlackInitConfig;
  feishuConfig?: FeishuInitConfig;
  gatewayUsage: GatewayUsageConfig;
  installService: boolean;
  /** Explicit (mode, model) for the `plan` profile. Non-interactive only; interactive picks
   *  inside runGatewaySetup once endpoints are discovered. Undefined → auto-infer. */
  planChoice?: ModelChoice;
  /** Explicit (mode, model) for the `execute` profile. Same semantics as planChoice. */
  executeChoice?: ModelChoice;
  /** Additional models to register as standalone named profiles. Non-interactive only. */
  extraProfiles?: ModelChoice[];
}

/** Parse "mode:model" stdin string into a ModelChoice. Returns undefined for empty/invalid. */
function parseChoiceLine(raw: string | undefined): ModelChoice | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0 || colonIdx === trimmed.length - 1) return undefined;
  return {
    mode: trimmed.substring(0, colonIdx).trim(),
    model: trimmed.substring(colonIdx + 1).trim(),
  };
}

/** Parse comma-separated "mode:model" pairs for extra profiles. Returns undefined for empty. */
function parseExtraProfilesLine(raw: string | undefined): ModelChoice[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const choices: ModelChoice[] = [];
  for (const part of trimmed.split(',')) {
    const choice = parseChoiceLine(part.trim());
    if (choice) choices.push(choice);
  }
  return choices.length > 0 ? choices : undefined;
}

// ─── Dot env generation ──────────────────────────────────────────

/** Generate .env content — includes CORTEX_MACHINE, CORTEX_PLATFORM, and platform-specific tokens. */
export function generateDotEnvContent(answers: InitAnswers): string {
  const lines: string[] = [
    '# Cortex Configuration',
    '# Generated by `cortex init`',
    '',
    `CORTEX_MACHINE=${answers.machineName}`,
    '',
    '# Auth tokens — WS client (cortex-client ↔ server) + webhook bearer. Required (fail-closed).',
    '# Remote cortex-client machines must share CORTEX_CLIENT_TOKEN. Rotate by editing here + restart.',
    `CORTEX_CLIENT_TOKEN=${randomBytes(32).toString('hex')}`,
    `CORTEX_WEBHOOK_TOKEN=${randomBytes(32).toString('hex')}`,
  ];

  // CORTEX_PLATFORM is a comma-separated list (runtime composes adapters via CompositeAdapter).
  // Each platform's token block is emitted independently when its config is present, so a
  // multi-select (e.g. slack + feishu) produces both blocks.
  if (answers.platforms.length > 0) {
    lines.push(`CORTEX_PLATFORM=${answers.platforms.join(',')}`);
    lines.push('');

    if (answers.slackConfig) {
      lines.push('# Slack configuration');
      lines.push(`SLACK_BOT_TOKEN=${answers.slackConfig.botToken}`);
      lines.push(`SLACK_SIGNING_SECRET=${answers.slackConfig.signingSecret}`);
      lines.push(`SLACK_APP_TOKEN=${answers.slackConfig.appToken}`);
      lines.push('');
    }

    if (answers.feishuConfig) {
      lines.push('# Feishu configuration');
      lines.push(`FEISHU_APP_ID=${answers.feishuConfig.appId}`);
      lines.push(`FEISHU_APP_SECRET=${answers.feishuConfig.appSecret}`);
      if (answers.feishuConfig.domain) {
        lines.push(`FEISHU_DOMAIN=${answers.feishuConfig.domain}`);
      }
      // Identity for MCP doc operations (binary, no fallback). Messaging is always bot.
      // user mode authorizes via `cortex feishu login` (OAuth device flow) — no redirect URI.
      lines.push(`FEISHU_AUTH_MODE=${answers.feishuConfig.authMode ?? 'bot'}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─── Configuration generation ────────────────────────────────────

/** Generate default mode.json content (compact JSON, single line). */
export function generateDefaultModeJson(primaryBackend: InitBackend = 'claude'): string {
  return JSON.stringify({
    mode: 'plan',
    backend: primaryBackend,
    claudeModel: 'opus',
    activeProfile: '__active__',
    defaultAgent: 'direct',
  });
}

// ─── Config output formatting ────────────────────────────────────

/** Status info for the config display */
export interface ConfigStatus {
  dataDirExists: boolean;
  dotEnvExists: boolean;
  mcpConfigExists: boolean;
  modeJsonExists: boolean;
}

/** Format resolved paths and initialization status for `cortex config` output. */
export function formatConfigOutput(paths: InitPaths & { INSTALL_ROOT: string }, status: ConfigStatus): string {
  const found = t('init.config.found');
  const missing = t('init.config.missing');
  const lines: string[] = [
    t('init.config.title'),
    `  INSTALL_ROOT:  ${paths.INSTALL_ROOT}`,
    `  DATA_DIR:      ${paths.DATA_DIR}`,
    `  CONFIG_DIR:    ${paths.CONFIG_DIR}`,
    `  STORE_DIR:     ${paths.STORE_DIR}`,
    `  CONTEXT_DIR:   ${paths.CONTEXT_DIR}`,
    `  PROJECTS_DIR:  ${paths.PROJECTS_DIR}`,
    `  WORKSPACE_DIR: ${paths.WORKSPACE_DIR}`,
    '',
    t('init.config.statusTitle'),
    `  DATA_DIR:      ${status.dataDirExists ? t('init.config.initialized') : t('init.config.notInitialized')}`,
    `  .env:          ${status.dotEnvExists ? found : missing}`,
    `  mcp-config.json: ${status.mcpConfigExists ? found : missing}`,
    `  mode.json:     ${status.modeJsonExists ? found : missing}`,
  ];
  return lines.join('\n');
}

// ─── Backend detection & installation ────────────────────────────

const BACKEND_INFO: Record<InitBackend, { bin: string; npmPackage: string; labelKey: string; loginHintKey: string }> = {
  claude: {
    bin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    labelKey: 'init.backend.label.claude',
    loginHintKey: 'init.backend.loginHint.claude',
  },
  pi: {
    bin: 'pi',
    npmPackage: '@mariozechner/pi-coding-agent',
    labelKey: 'init.backend.label.pi',
    loginHintKey: 'init.backend.loginHint.pi',
  },
};

// ─── Slack App Manifest ──────────────────────────────────────────

/** Slack App Manifest for Cortex bot. Users paste this when creating a Slack App via "From a manifest". */
export const SLACK_APP_MANIFEST = JSON.stringify({
  display_information: {
    name: 'Cortex',
    description: 'Autonomous research agent',
    background_color: '#2c2d30',
  },
  features: {
    bot_user: {
      display_name: 'Cortex',
      always_online: true,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        'chat:write',
        'im:history',
        'im:write',
        'reactions:read',
        'reactions:write',
        'users:read',
        'commands',
        'app_mentions:read',
        'channels:history',
        'channels:read',
        'groups:history',
        'files:read',
        'files:write',
        'emoji:read',
        'pins:read',
        'pins:write',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        'message.im',
        'message.channels',
        'message.groups',
        'app_mention',
      ],
    },
    interactivity: {
      is_enabled: false,
    },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}, null, 2);

// ─── Clipboard utilities ─────────────────────────────────────────

/**
 * Copy text to system clipboard.
 * Tries OSC 52 escape sequence first (works in modern terminals without external tools,
 * same approach Claude Code uses), then falls back to platform-specific CLI tools.
 * Returns true on success.
 */
function copyToClipboard(text: string): boolean {
  // 1. OSC 52 escape sequence — no external tool needed, works in VS Code, iTerm2,
  //    Windows Terminal, Kitty, WezTerm, foot, and most modern terminal emulators.
  if (process.stdout.isTTY) {
    const b64 = Buffer.from(text, 'utf-8').toString('base64');
    // BEL-terminated variant (wider terminal support than ST)
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    // Assume success — terminals silently ignore OSC 52 if unsupported/disabled
    return true;
  }

  // 2. Platform-specific external clipboard tools (fallback for non-TTY)
  const commands: [string, string[]][] = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
    ? [['clip', []]]
    : [
        ['xclip', ['-selection', 'clipboard']],
        ['wl-copy', []],
        ['xsel', ['--clipboard', '--input']],
      ];

  for (const [bin, args] of commands) {
    try {
      const cmd = [bin, ...args].join(' ');
      execSync(cmd, { input: text, stdio: 'pipe', timeout: 3000 });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Prompt user to press 'c' to copy manifest to clipboard. Single-key, no Enter needed. */
async function promptCopyManifestToClipboard(manifest: string): Promise<void> {
  if (!process.stdin.isTTY) return; // Non-interactive mode, skip

  process.stdout.write(t('init.clipboard.prompt'));

  return new Promise((resolve) => {
    const wasRaw = (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      process.stdout.write('\r\x1b[K');
      resolve();
      return;
    }

    const onData = (key: Buffer) => {
      const ch = key.toString();

      // Erase the typed character from screen
      process.stdout.write('\b \b');

      // Restore stdin to previous state
      try {
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
      } catch { /* best effort */ }
      process.stdin.removeListener('data', onData);

      // Clear the prompt line
      process.stdout.write('\r\x1b[K');

      if (ch.toLowerCase() === 'c') {
        const ok = copyToClipboard(manifest);
        if (ok) {
          clack.log.success(t('init.clipboard.copied'));
        } else {
          clack.log.warn(t('init.clipboard.failed'));
          clack.log.info(t('init.clipboard.manual'));
        }
      }
      resolve();
    };

    process.stdin.on('data', onData);
  });
}

/** Parse existing Slack configuration from a .env file. Returns null if no Slack config found. */
function parseExistingEnvSlackConfig(envPath: string): { signingSecret?: string; appToken?: string; botToken?: string } | null {
  if (!existsSync(envPath)) return null;
  try {
    const content = readFileSync(envPath, 'utf-8');
    const result: { signingSecret?: string; appToken?: string; botToken?: string } = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (key === 'SLACK_SIGNING_SECRET') result.signingSecret = value;
      else if (key === 'SLACK_APP_TOKEN') result.appToken = value;
      else if (key === 'SLACK_BOT_TOKEN') result.botToken = value;
    }
    if (!result.signingSecret && !result.appToken && !result.botToken) return null;
    return result;
  } catch {
    return null;
  }
}

/** Check whether a backend binary is on PATH. */
export function isBackendInstalled(backend: InitBackend): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const { bin } = BACKEND_INFO[backend];
  try {
    execSync(`${cmd} ${bin}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Return the npm install command for a backend. */
export function getInstallCommand(backend: InitBackend): string {
  return `npm install -g ${BACKEND_INFO[backend].npmPackage}`;
}

/** Detect GPU count via nvidia-smi. Returns 0 if nvidia-smi is unavailable or no GPUs found. */
function detectGpuCount(): number {
  try {
    const result = execSync('nvidia-smi --query-gpu=count --format=csv,noheader', {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5000,
    });
    const count = parseInt(result.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

/** Check and install selected backends. Returns list of backends that were installed. */
async function checkAndInstallBackends(backends: InitBackend[]): Promise<void> {
  for (const backend of backends) {
    const info = BACKEND_INFO[backend];
    const label = t(info.labelKey);
    const installed = isBackendInstalled(backend);

    if (installed) {
      clack.log.success(t('init.backend.alreadyInstalled', { label }));
    } else {
      const s = clack.spinner();
      s.start(t('init.backend.installing', { label }));
      try {
        execSync(getInstallCommand(backend), { stdio: 'pipe', timeout: 120_000 });
        s.stop(t('init.backend.installed', { label }));
      } catch (err: any) {
        s.stop(t('init.backend.installFailed', { label }));
        clack.log.error(t('init.backend.installFailedHint', { command: getInstallCommand(backend) }));
      }
    }

    clack.log.info(t(info.loginHintKey));
  }
}

// ─── Gateway usage config ────────────────────────────────────────

/** Path to aistatus config file. */
export function getAistatusConfigPath(): string {
  return path.join(os.homedir(), '.aistatus', 'config.yaml');
}

/** Generate gateway usage config YAML string. */
export function generateGatewayUsageYaml(config: GatewayUsageConfig): string {
  const doc: Record<string, unknown> = { uploadEnabled: config.enabled };
  if (config.enabled) {
    doc.name = config.name || '';
    doc.org = config.org || '';
    doc.email = config.email || '';
  }
  return yaml.stringify(doc);
}

/** Write gateway usage config to ~/.aistatus/config.yaml, or <configDir>/config.yaml if configDir is given (for testing). */
function writeGatewayUsageConfig(config: GatewayUsageConfig, configDir?: string): void {
  const configPath = configDir
    ? path.join(configDir, 'config.yaml')
    : getAistatusConfigPath();
  const configDirPath = path.dirname(configPath);
  mkdirSync(configDirPath, { recursive: true });

  // Preserve existing fields (e.g. gateway.yaml keys) if config.yaml already exists
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = yaml.parse(readFileSync(configPath, 'utf-8')) || {};
    } catch { /* ignore parse errors, overwrite */ }
  }

  const merged = {
    ...existing,
    name: config.enabled ? (config.name || '') : (existing.name ?? ''),
    org: config.enabled ? (config.org || '') : (existing.org ?? ''),
    email: config.enabled ? (config.email || '') : (existing.email ?? ''),
    uploadEnabled: config.enabled,
  };

  writeFileSync(configPath, yaml.stringify(merged));
}

// ─── Service registration ────────────────────────────────────────

/** Generate systemd unit file content for Linux. */
export function generateSystemdUnit(user: string, cortexBin: string, dataDir: string): string {
  return [
    '[Unit]',
    'Description=Cortex Agent Server',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `ExecStart=${cortexBin} daemon`,
    `Environment=CORTEX_HOME=${dataDir}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** Generate launchd plist content for macOS. */
export function generateLaunchdPlist(user: string, cortexBin: string, dataDir: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>cc.cortex.agent-server</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${cortexBin}</string>`,
    '    <string>daemon</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>CORTEX_HOME</key>',
    `    <string>${dataDir}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${dataDir}/logs/cortex-stdout.log</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${dataDir}/logs/cortex-stderr.log</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Resolve the cortex binary path (used in service files). */
function resolveCortexBin(): string {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execSync(`${cmd} cortex`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    // Fallback: node + cli.js
    return `${process.execPath} ${path.join(INSTALL_ROOT, 'dist', 'entry', 'cli.js')}`;
  }
}

/** Check if we have sudo/root access (Linux/macOS only). */
function hasSudo(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execSync('sudo -n true', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Install the service file. Returns true if installed by us, false if manual action needed. */
function installService(dataDir: string): void {
  const user = os.userInfo().username;
  const cortexBin = resolveCortexBin();
  const platform = process.platform;

  if (platform === 'darwin') {
    const plistName = 'cc.cortex.agent-server.plist';
    const plistContent = generateLaunchdPlist(user, cortexBin, dataDir);
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', plistName);

    writeFileSync(plistPath, plistContent);
    clack.log.success(t('init.service.launchdWritten', { path: plistPath }));
    clack.log.info(t('init.service.launchdStartHint', { path: plistPath }));
  } else if (platform === 'linux') {
    const unitContent = generateSystemdUnit(user, cortexBin, dataDir);
    const unitName = 'cortex.service';
    const systemPath = `/etc/systemd/system/${unitName}`;
    const userUnitDir = path.join(os.homedir(), '.config', 'systemd', 'user');

    // Try user-level systemd first (no sudo needed)
    try {
      mkdirSync(userUnitDir, { recursive: true });
      const userUnitPath = path.join(userUnitDir, unitName);
      writeFileSync(userUnitPath, unitContent);
      clack.log.success(t('init.service.systemdUserWritten', { path: userUnitPath }));
      clack.log.info(t('init.service.systemdUserEnableHint'));
      return;
    } catch {
      // Fall through to system-level
    }

    // System-level: needs sudo
    if (hasSudo()) {
      try {
        const tmpPath = path.join(os.tmpdir(), unitName);
        writeFileSync(tmpPath, unitContent);
        execSync(`sudo cp ${tmpPath} ${systemPath} && sudo systemctl daemon-reload`, { stdio: 'pipe' });
        clack.log.success(t('init.service.systemdInstalled', { path: systemPath }));
        clack.log.info(t('init.service.systemdEnableHint'));
      } catch (err: any) {
        clack.log.warn(t('init.service.systemInstallFailed', { message: err.message }));
      }
    } else {
      // No sudo — write to config dir and show instructions
      const localPath = path.join(dataDir, 'config', unitName);
      writeFileSync(localPath, unitContent);
      clack.log.warn(t('init.service.noSudo'));
      clack.log.info(t('init.service.manualInstallHint', { localPath, systemPath }));
    }
  } else {
    clack.log.warn(t('init.service.unsupported', { platform }));
  }
}

// ─── Interactive prompts (TTY) ───────────────────────────────────

function handleCancel(value: unknown): asserts value {
  if (clack.isCancel(value)) {
    clack.cancel(t('init.cancel'));
    process.exit(0);
  }
}

async function collectSlackConfig(prefill?: { signingSecret?: string; appToken?: string; botToken?: string }): Promise<SlackInitConfig> {
  clack.note(SLACK_APP_MANIFEST, t('init.slack.manifestTitle'));

  clack.note(
    t('init.slack.guide'),
    t('init.slack.guideTitle'),
  );

  await promptCopyManifestToClipboard(SLACK_APP_MANIFEST);

  const hasPrefill = prefill && (prefill.signingSecret || prefill.appToken || prefill.botToken);

  let signingSecret: string | symbol;
  let appToken: string | symbol;
  let botToken: string | symbol;

  if (hasPrefill) {
    clack.log.info(t('init.slack.prefillFound'));
    const skip = await clack.text({
      message: t('init.slack.skipPrompt'),
      placeholder: t('init.slack.skipPlaceholder'),
      defaultValue: '',
    });
    handleCancel(skip);

    if ((skip as string).trim() === '') {
      // User pressed Enter — reuse prefill values.
      signingSecret = prefill!.signingSecret!;
      appToken = prefill!.appToken!;
      botToken = prefill!.botToken!;
    }
  }

  if (!signingSecret) {
    signingSecret = await (clack.password as any)({
      message: t('init.slack.signingSecretPrompt'),
      validate(value) {
        if (!value) return t('init.slack.signingSecretRequired');
      },
    });
    handleCancel(signingSecret);

    appToken = await (clack.password as any)({
      message: t('init.slack.appTokenPrompt'),
      validate(value) {
        if (!value) return t('init.slack.appTokenRequired');
        if (!value.startsWith('xapp-')) return t('init.slack.appTokenPrefix');
      },
    });
    handleCancel(appToken);

    botToken = await (clack.password as any)({
      message: t('init.slack.botTokenPrompt'),
      validate(value) {
        if (!value) return t('init.slack.botTokenRequired');
        if (!value.startsWith('xoxb-')) return t('init.slack.botTokenPrefix');
      },
    });
    handleCancel(botToken);
  }

  return {
    signingSecret: signingSecret as string,
    appToken: appToken as string,
    botToken: botToken as string,
  };
}

async function collectFeishuConfig(): Promise<FeishuInitConfig> {
  clack.note(
    t('init.feishu.guide'),
    t('init.feishu.guideTitle'),
  );

  const appId = await clack.text({
    message: t('init.feishu.appIdPrompt'),
    validate(value) {
      if (!value) return t('init.feishu.appIdRequired');
    },
  });
  handleCancel(appId);

  const appSecret = await clack.password({
    message: t('init.feishu.appSecretPrompt'),
    validate(value) {
      if (!value) return t('init.feishu.appSecretRequired');
    },
  });
  handleCancel(appSecret);

  const domainRaw = await clack.text({
    message: t('init.feishu.domainPrompt'),
    placeholder: t('init.feishu.domainPlaceholder'),
  });
  handleCancel(domainRaw);

  const domainVal = (domainRaw as string).trim().toLowerCase();
  const domain = (domainVal === 'feishu' || domainVal === 'lark')
    ? (domainVal as 'feishu' | 'lark')
    : undefined;

  const authMode = await clack.select({
    message: t('init.feishu.authModePrompt'),
    options: [
      { value: 'bot' as const, label: t('init.feishu.authModeBotLabel'), hint: t('init.feishu.authModeBotHint') },
      { value: 'user' as const, label: t('init.feishu.authModeUserLabel'), hint: t('init.feishu.authModeUserHint') },
    ],
    initialValue: 'user' as const,
  });
  handleCancel(authMode);

  return {
    appId: appId as string,
    appSecret: appSecret as string,
    domain,
    authMode: authMode as 'bot' | 'user',
  };
}

/**
 * Run the Feishu user-identity login inline during init (OAuth device-authorization flow).
 * Invoked right after the operator selects authMode='user' so they authorize in one sitting
 * instead of having to run `cortex feishu login` afterwards.
 *
 * Credentials are passed via deps.env (no .env on disk yet at questionnaire time), and the token
 * is written next to the .env (CONFIG_DIR/feishu-user-token.json) so it matches the --home target
 * even when that differs from the module-level CONFIG_DIR. Best-effort: returns the CliResult and
 * never throws, so a failed/abandoned login does not abort init — the operator can retry later.
 */
export async function runFeishuUserLogin(
  config: FeishuInitConfig,
  configDir: string,
  deps: { cmdFeishuImpl?: typeof cmdFeishu; stdout?: (s: string) => void } = {},
): Promise<CliResult> {
  const cmd = deps.cmdFeishuImpl ?? cmdFeishu;
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FEISHU_APP_ID: config.appId,
    FEISHU_APP_SECRET: config.appSecret,
  };
  if (config.domain) env.FEISHU_DOMAIN = config.domain;

  const tokenFile = path.join(configDir, 'feishu-user-token.json');
  const result = await cmd(['login'], { env, tokenFile, loadDotenv: false });

  if (result.stdout) out(result.stdout);
  if (result.exitCode !== 0 && result.stderr) out(result.stderr);
  return result;
}

async function collectAnswersInteractive(paths: InitPaths): Promise<InitAnswers> {
  // Step 0: Language selection — shown first and bilingually (the prompt itself is always
  // bilingual since no choice has been made yet). The option pre-selected as the default is
  // inferred from the system locale (Chinese system → 中文 highlighted, otherwise English), so a
  // Chinese user can just press Enter. The choice is applied immediately via setLocale() so every
  // subsequent prompt renders in that language, and persisted to config/preferences.json.
  const detected = detectSystemLocale();
  const langSel = await clack.select({
    message: 'Select language / 选择语言',
    options: [
      { value: 'en' as Locale, label: 'English' },
      { value: 'zh' as Locale, label: '中文 (Simplified Chinese)' },
    ],
    initialValue: detected,
  });
  handleCancel(langSel);
  const lang = langSel as Locale;
  setLocale(lang);

  clack.intro(t('init.intro'));

  // Step 1: Backend selection
  clack.note(
    t('init.backend.noteBody'),
    t('init.backend.noteTitle'),
  );
  const backends = await clack.multiselect({
    message: t('init.backend.prompt'),
    options: [
      { value: 'claude' as InitBackend, label: t('init.backend.claudeLabel'), hint: t('init.backend.claudeHint') },
      { value: 'pi' as InitBackend, label: t('init.backend.piLabel'), hint: t('init.backend.piHint') },
    ],
    required: true,
  });
  handleCancel(backends);

  // Step 2: Platform selection (multi-select — Slack and Feishu can run simultaneously).
  // Leave empty to skip and configure platforms later by editing .env manually.
  const platformsSel = await clack.multiselect({
    message: t('init.platform.prompt'),
    options: [
      { value: 'slack' as PlatformChoice, label: t('init.platform.slackLabel'), hint: t('init.platform.slackHint') },
      { value: 'feishu' as PlatformChoice, label: t('init.platform.feishuLabel') },
    ],
    required: false,
  });
  handleCancel(platformsSel);
  const platforms = platformsSel as PlatformChoice[];

  // Step 2b: Platform-specific setup & token input — walk each selected platform in turn,
  // showing its creation guide and collecting its credentials one at a time.
  let slackConfig: SlackInitConfig | undefined;
  let feishuConfig: FeishuInitConfig | undefined;

  if (platforms.includes('slack')) {
    const envPath = path.join(paths.CONFIG_DIR, '.env');
    const existingSlackConfig = parseExistingEnvSlackConfig(envPath);
    slackConfig = await collectSlackConfig(existingSlackConfig ?? undefined);
  }
  if (platforms.includes('feishu')) {
    feishuConfig = await collectFeishuConfig();
    // user identity → continue straight into the device-flow login (rather than only printing a
    // hint to run `cortex feishu login` later). Best-effort: a failed/abandoned login won't abort
    // init — credentials are already captured in feishuConfig and the operator can retry.
    if (feishuConfig.authMode === 'user') {
      clack.log.info(t('init.feishu.loginStarting'));
      const res = await runFeishuUserLogin(feishuConfig, paths.CONFIG_DIR);
      if (res.exitCode === 0) {
        clack.log.success(t('init.feishu.loginComplete'));
      } else {
        clack.log.warn(t('init.feishu.loginIncomplete'));
      }
    }
  }

  // Step 3: Machine identity
  const hostname = os.hostname();
  const machineName = await clack.text({
    message: t('init.machine.prompt'),
    placeholder: hostname,
    defaultValue: hostname,
    validate(value) {
      if (!value) return t('init.machine.required');
    },
  });
  handleCancel(machineName);

  // GPU detection
  const gpuCount = detectGpuCount();
  if (gpuCount > 0) {
    clack.log.success(t('init.machine.gpuDetected', { count: gpuCount }));
  } else {
    clack.log.info(t('init.machine.gpuNone'));
  }

  // Step 4: Gateway usage
  clack.note(
    t('init.gateway.note'),
    t('init.gateway.noteTitle'),
  );

  const enableGateway = await clack.confirm({
    message: t('init.gateway.enablePrompt'),
    initialValue: true,
  });
  handleCancel(enableGateway);

  let gatewayUsage: GatewayUsageConfig = { enabled: false };
  if (enableGateway) {
    const name = await clack.text({ message: t('init.gateway.namePrompt'), placeholder: t('init.gateway.namePlaceholder') });
    handleCancel(name);

    const org = await clack.text({ message: t('init.gateway.orgPrompt'), placeholder: t('init.gateway.orgPlaceholder') });
    handleCancel(org);

    const email = await clack.text({
      message: t('init.gateway.emailPrompt'),
      placeholder: t('init.gateway.emailPlaceholder'),
    });
    handleCancel(email);

    gatewayUsage = { enabled: true, name: name as string, org: org as string, email: email as string };
  }

  // Step 5: Service registration
  const wantService = await clack.confirm({
    message: t('init.serviceRegister.prompt'),
    initialValue: true,
  });
  handleCancel(wantService);

  return {
    lang,
    backends: backends as InitBackend[],
    machineName: machineName as string,
    gpuCount,
    platforms,
    slackConfig,
    feishuConfig,
    gatewayUsage,
    installService: wantService as boolean,
  };
}

// ─── Non-interactive prompts (piped stdin) ───────────────────────

async function collectAnswersNonInteractive(): Promise<InitAnswers> {
  const lines: string[] = [];
  const rl = createInterface({ input: processStdin });
  for await (const line of rl) {
    lines.push(line);
  }

  // Line format:
  //   backends, platform, gatewayEnabled, name, org, email, installService
  //   [+ platform-specific token blocks, concatenated in fixed order: slack first, then feishu]
  // `platform` is a comma-separated list (e.g. "slack,feishu"); single values are back-compat.
  const [backendsRaw, platformRaw, gatewayEnabledRaw, name, org, email, installServiceRaw] = lines;

  const backends = (backendsRaw || 'claude')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is InitBackend => s === 'claude' || s === 'pi');

  // Parse the platform list, keeping valid values in order and de-duplicating.
  const platforms: PlatformChoice[] = [];
  const seenPlatforms = new Set<string>();
  for (const raw of (platformRaw || '').split(',')) {
    const p = raw.trim().toLowerCase();
    if ((p === 'slack' || p === 'feishu') && !seenPlatforms.has(p)) {
      seenPlatforms.add(p);
      platforms.push(p);
    }
  }

  const gatewayEnabled = gatewayEnabledRaw?.toLowerCase() === 'y';

  log.info('Cortex Initialization (non-interactive)');

  // Parse platform token blocks from remaining lines (starting at index 7). Blocks are
  // concatenated in fixed order — slack (3 lines), then feishu (3 lines) — regardless of the
  // order given in the platform list. The profile-choice lines (optional "mode:model"; empty
  // → auto-infer) follow whatever token lines were consumed. Single-platform layouts are
  // back-compatible: slack-only → choices at 10; feishu-only → choices at 10.
  let slackConfig: SlackInitConfig | undefined;
  let feishuConfig: FeishuInitConfig | undefined;
  let cursor = 7;

  if (platforms.includes('slack') && lines.length >= cursor + 3) {
    slackConfig = {
      signingSecret: lines[cursor] || '',
      appToken: lines[cursor + 1] || '',
      botToken: lines[cursor + 2] || '',
    };
    cursor += 3;
  }
  if (platforms.includes('feishu') && lines.length >= cursor + 3) {
    const domainVal = (lines[cursor + 2] || '').trim().toLowerCase();
    feishuConfig = {
      appId: lines[cursor] || '',
      appSecret: lines[cursor + 1] || '',
      domain: (domainVal === 'feishu' || domainVal === 'lark')
        ? (domainVal as 'feishu' | 'lark')
        : undefined,
    };
    cursor += 3;
  }
  const profileChoiceStart = cursor;

  const planChoice = parseChoiceLine(lines[profileChoiceStart]);
  const executeChoice = parseChoiceLine(lines[profileChoiceStart + 1]);
  const extraProfiles = parseExtraProfilesLine(lines[profileChoiceStart + 2]);

  return {
    lang: process.env.CORTEX_LANG ? normalizeLocale(process.env.CORTEX_LANG) : detectSystemLocale(),
    backends: backends.length > 0 ? backends : ['claude'],
    machineName: os.hostname(),
    gpuCount: detectGpuCount(),
    platforms,
    slackConfig,
    feishuConfig,
    gatewayUsage: gatewayEnabled
      ? { enabled: true, name: name || '', org: org || '', email: email || '' }
      : { enabled: false },
    installService: installServiceRaw?.toLowerCase() === 'y',
    planChoice,
    executeChoice,
    extraProfiles,
  };
}

// ─── Directory creation ─────────────────────────────────────────

function createDirectories(paths: InitPaths): void {
  const dirs = [
    paths.DATA_DIR,
    paths.CONFIG_DIR,
    paths.STORE_DIR,
    path.join(paths.DATA_DIR, 'logs', 'sessions'),
    path.join(paths.WORKSPACE_DIR, 'threads'),
    paths.PROJECTS_DIR,
    // Dense Context structure
    path.join(paths.CONTEXT_DIR, 'user'),
    path.join(paths.CONTEXT_DIR, 'decisions'),
    path.join(paths.CONTEXT_DIR, 'scans'),
    path.join(paths.CONTEXT_DIR, 'ideas'),
    path.join(paths.CONTEXT_DIR, 'retrospectives'),
    // Claude Code config
    path.join(paths.DATA_DIR, '.claude', 'hooks'),
    path.join(paths.DATA_DIR, '.claude', 'rules'),
    // Runtime directories
    path.join(paths.DATA_DIR, 'plugins'),
    path.join(paths.DATA_DIR, 'prompts', 'directives'),
    path.join(paths.DATA_DIR, 'prompts', 'systemPrompts'),
    path.join(paths.DATA_DIR, 'prompts', 'promptTemplates'),
    path.join(paths.DATA_DIR, 'hooks'),
    path.join(paths.DATA_DIR, 'plan'),
    path.join(paths.DATA_DIR, 'logs', 'sessions-pi'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

// ─── Git detection & installation ────────────────────────────────

/** Check whether git is available on PATH. */
export function isGitInstalled(): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(`${cmd} git`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the system package manager on Linux and return its install command prefix.
 * Returns null if no known package manager is found.
 */
function detectLinuxPkgInstall(): string | null {
  const candidates: { bin: string; install: string }[] = [
    { bin: '/usr/bin/apt-get', install: 'apt-get install -y' },
    { bin: '/usr/bin/dnf',     install: 'dnf install -y' },
    { bin: '/usr/bin/yum',     install: 'yum install -y' },
    { bin: '/usr/bin/pacman',  install: 'pacman -S --noconfirm' },
    { bin: '/usr/bin/zypper',  install: 'zypper install -y' },
    { bin: '/sbin/apk',        install: 'apk add' },
  ];
  for (const c of candidates) {
    if (existsSync(c.bin)) return c.install;
  }
  return null;
}

/** Return a human-readable install instruction for git on the current platform. */
export function getGitInstallHint(): string {
  switch (process.platform) {
    case 'linux': {
      const pkg = detectLinuxPkgInstall();
      if (pkg) return `sudo ${pkg} git`;
      return 'Install git via your package manager or download from https://git-scm.com/downloads/linux';
    }
    case 'darwin':
      return 'xcode-select --install  (or  brew install git  if you use Homebrew)';
    case 'win32':
      return 'winget install --id Git.Git -e --source winget';
    default:
      return 'Download from https://git-scm.com/downloads';
  }
}

/**
 * Ensure git is available on PATH. If missing, attempt automatic installation.
 * Returns true if git is now available, false otherwise.
 */
export function ensureGitInstalled(): boolean {
  if (isGitInstalled()) return true;

  clack.log.warn(t('init.git.required'));

  // Build the auto-install command for the current platform
  let installCmd: string | null = null;
  if (process.platform === 'linux') {
    const pkg = detectLinuxPkgInstall();
    if (pkg) installCmd = `sudo ${pkg} git`;
  } else if (process.platform === 'darwin') {
    // Prefer brew in headless contexts; xcode-select --install opens a GUI dialog
    try {
      execSync('which brew', { stdio: 'pipe' });
      installCmd = 'brew install git';
    } catch {
      installCmd = 'xcode-select --install';
    }
  } else if (process.platform === 'win32') {
    installCmd = 'winget install --id Git.Git -e --source winget --silent';
  }

  if (installCmd) {
    const s = clack.spinner();
    s.start(t('init.git.autoInstalling'));
    try {
      execSync(installCmd, { stdio: 'pipe', timeout: 120_000 });
      s.stop(t('init.git.installed'));
      // Verify the install actually put git on PATH
      if (isGitInstalled()) return true;
      clack.log.warn(t('init.git.notOnPath'));
    } catch (err: any) {
      s.stop(t('init.git.autoInstallFailed'));
      clack.log.warn(err.message);
    }
  }

  const hint = getGitInstallHint();
  clack.log.info(t('init.git.manualHint', { hint }));
  return false;
}

// ─── Git repo initialization ────────────────────────────────────

function ensureGitRepo(dataDir: string): void {
  if (existsSync(path.join(dataDir, '.git'))) return;
  try {
    execSync('git init', { cwd: dataDir, stdio: 'pipe' });
  } catch (err: any) {
    clack.log.warn(t('init.git.initFailed', { message: err.message }));
  }
}

// ─── Safe copy helpers ──────────────────────────────────────────

export function safeCopy(src: string, dst: string, force: boolean, _label: string): boolean {
  if (!existsSync(src)) return false;
  if (existsSync(dst) && !force) return false;
  const dstDir = path.dirname(dst);
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
  copyFileSync(src, dst);
  return true;
}

/**
 * Recursively seed a directory tree from defaults/ into DATA_DIR. Per-file behavior matches
 * safeCopy(): existing files are preserved unless force=true. New files in defaults/ that the
 * user hasn't created are always added (so package upgrades automatically deliver new
 * directives/skills without overwriting user edits).
 */
function safeCopyDir(srcDir: string, dstDir: string, force: boolean): void {
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      safeCopyDir(srcPath, dstPath, force);
    } else if (entry.isFile()) {
      if (existsSync(dstPath) && !force) continue;
      copyFileSync(srcPath, dstPath);
    }
  }
}

// ─── Config copy & generation ──────────────────────────────────

function copyDefaults(paths: InitPaths, force: boolean): void {
  // Scaffold files — never overwrite (user-customized content)
  safeCopy(path.join(DEFAULTS_DIR, 'CORTEX.md'), path.join(paths.DATA_DIR, 'CORTEX.md'), false, 'CORTEX.md');
  safeCopy(path.join(DEFAULTS_DIR, 'gitignore'), path.join(paths.DATA_DIR, '.gitignore'), false, '.gitignore');
  safeCopy(path.join(DEFAULTS_DIR, '.claude', 'settings.json'), path.join(paths.DATA_DIR, '.claude', 'settings.json'), false, '.claude/settings.json');

  // Context scaffold files — never overwrite
  safeCopy(path.join(DEFAULTS_DIR, 'context', 'CORTEX.md'), path.join(paths.CONTEXT_DIR, 'CORTEX.md'), false, 'context/CORTEX.md');
  safeCopy(path.join(DEFAULTS_DIR, 'context', 'projects', 'CORTEX.md'), path.join(paths.PROJECTS_DIR, 'CORTEX.md'), false, 'context/projects/CORTEX.md');
  safeCopy(path.join(DEFAULTS_DIR, 'context', 'scans', 'CORTEX.md'), path.join(paths.CONTEXT_DIR, 'scans', 'CORTEX.md'), false, 'context/scans/CORTEX.md');
  safeCopy(path.join(DEFAULTS_DIR, 'context', 'ideas', 'CORTEX.md'), path.join(paths.CONTEXT_DIR, 'ideas', 'CORTEX.md'), false, 'context/ideas/CORTEX.md');
  safeCopy(path.join(DEFAULTS_DIR, 'context', 'user', 'CORTEX.md'), path.join(paths.CONTEXT_DIR, 'user', 'CORTEX.md'), false, 'context/user/CORTEX.md');

  // Config defaults — budget overwrites only with --force;
  // thread-templates are merged per-file (new agents/templates/shells added, existing preserved)
  safeCopy(path.join(DEFAULTS_DIR, 'config', 'budget.json'), path.join(paths.CONFIG_DIR, 'budget.json'), force, 'budget.json');
  mergeThreadTemplates(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(paths.CONFIG_DIR, 'thread-templates'),
  );
  // Seed asset trees — per-file safeCopy semantics: new files always added, existing files
  // preserved unless force=true. These directories are referenced at runtime; without them
  // thread-manager / skill-scanner / rules-loader can't find their inputs.
  safeCopyDir(path.join(DEFAULTS_DIR, 'prompts'), path.join(paths.DATA_DIR, 'prompts'), force);
  safeCopyDir(path.join(DEFAULTS_DIR, 'rules'), path.join(paths.DATA_DIR, 'rules'), force);
  safeCopyDir(path.join(DEFAULTS_DIR, 'plugins'), path.join(paths.DATA_DIR, 'plugins'), force);
  safeCopyDir(path.join(DEFAULTS_DIR, 'context', 'decisions'), path.join(paths.CONTEXT_DIR, 'decisions'), force);
}

/**
 * Deploy hook scripts from defaults/hooks/ to DATA_DIR/hooks/.
 * All hooks are standalone .mjs files referenced via HOOKS_DIR.
 */
function deployHooks(paths: InitPaths, force: boolean): void {
  const hooksDir = path.join(paths.DATA_DIR, 'hooks');
  const srcDir = path.join(DEFAULTS_DIR, 'hooks');

  if (!existsSync(srcDir)) return;
  mkdirSync(hooksDir, { recursive: true });

  const files = readdirSync(srcDir);
  for (const file of files) {
    if (!file.endsWith('.mjs')) continue;
    const src = path.join(srcDir, file);
    const dst = path.join(hooksDir, file);
    safeCopy(src, dst, force, `hooks/${file}`);
  }
}

function writeMcpConfigs(configDir: string): void {
  const configs: Array<[string, object]> = [
    ['mcp-config.json', buildFullConfig(INSTALL_ROOT)],
    ['mcp-config-core.json', buildCoreConfig(INSTALL_ROOT)],
    ['mcp-config-tasks.json', buildTasksConfig(INSTALL_ROOT)],
    ['mcp-config-manager-qa.json', buildManagerQaConfig(INSTALL_ROOT)],
    ['mcp-config-thread.json', buildThreadConfig(INSTALL_ROOT)],
    ['mcp-config-tui.json', buildTuiConfig(INSTALL_ROOT)],
  ];
  for (const [fileName, config] of configs) {
    writeFileSync(path.join(configDir, fileName), JSON.stringify(config, null, 2));
  }
}

export function generateConfigs(paths: InitPaths, answers: InitAnswers, force: boolean): void {
  // MCP configs — always regenerate (machine-specific, in .gitignore)
  writeMcpConfigs(paths.CONFIG_DIR);

  // mode.json — skip if exists (user may have customized)
  const modeJsonPath = path.join(paths.STORE_DIR, 'mode.json');
  if (!existsSync(modeJsonPath) || force) {
    const primaryBackend = answers.backends[0] || 'claude';
    writeFileSync(modeJsonPath, generateDefaultModeJson(primaryBackend));
  }

  // preferences.json — operator UI language (read at startup by domain/system/preferences.ts).
  // Skip if exists (user may have changed it via !lang) unless --force.
  const prefsJsonPath = path.join(paths.CONFIG_DIR, 'preferences.json');
  if (!existsSync(prefsJsonPath) || force) {
    writeFileSync(prefsJsonPath, JSON.stringify({ lang: answers.lang }, null, 2) + '\n');
  }

  // machines.json — runtime machine registry, server won't start without it
  const machinesJsonPath = path.join(paths.CONFIG_DIR, 'machines.json');
  if (!existsSync(machinesJsonPath) || force) {
    const entry: Record<string, unknown> = {
      cortexPath: paths.DATA_DIR,
      gpuCount: answers.gpuCount,
    };
    const machines = { [answers.machineName]: entry };
    writeFileSync(machinesJsonPath, JSON.stringify(machines, null, 2) + '\n');
  }
}

/**
 * Seed schedules.json from defaults/data/schedules.json into STORE_DIR.
 * The __ADMIN_CHANNEL__ placeholder resolves to an empty channel: the admin channel is
 * auto-detected at runtime (first DM to the bot) rather than collected during init.
 * Stamps createdAt with the current timestamp. Never overwrites existing file.
 */
function seedSchedules(paths: InitPaths, answers: InitAnswers, force: boolean): void {
  const dstPath = path.join(paths.STORE_DIR, 'schedules.json');
  if (existsSync(dstPath) && !force) return;

  const srcPath = path.join(DEFAULTS_DIR, 'data', 'schedules.json');
  if (!existsSync(srcPath)) return;

  const adminChannel = '';
  const now = Date.now();

  let content = readFileSync(srcPath, 'utf-8');
  content = content.replace(/__ADMIN_CHANNEL__/g, adminChannel);

  // Stamp createdAt on all seed tasks
  const data = JSON.parse(content);
  for (const task of data.tasks) {
    if (task.createdAt === 0) task.createdAt = now;
  }

  mkdirSync(path.dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, JSON.stringify(data, null, 2) + '\n');
}

function writeDotEnv(paths: InitPaths, answers: InitAnswers, force: boolean): void {
  const envPath = path.join(paths.CONFIG_DIR, '.env');
  if (existsSync(envPath) && !force) return;
  const content = generateDotEnvContent(answers);
  writeFileSync(envPath, content);
}

// ─── Gateway & profile auto-setup ──────────────────────────────

/** Detect whether a profiles.json at <configDir>/profiles.json already has `plan` or `execute`. */
function detectExistingPlanOrExecute(configDir: string): boolean {
  const profilesPath = path.join(configDir, 'profiles.json');
  if (!existsSync(profilesPath)) return false;
  try {
    const data = JSON.parse(readFileSync(profilesPath, 'utf-8'));
    return !!(data?.profiles?.plan || data?.profiles?.execute);
  } catch {
    return false;
  }
}

/**
 * Interactively pick plan / execute (mode, model) from discovered endpoints, plus optional
 * fallback chains. Lists are sorted lexicographically; the first entry is pre-selected.
 *
 * Returns `overwrite: false` if the user declined to overwrite an existing profile — in that
 * case all *Choice / *Fallback fields are undefined.
 */
async function pickPlanExecuteInteractive(
  endpoints: ReturnType<typeof discoverEndpoints>,
  configDir: string,
): Promise<{
  planChoice?: ModelChoice;
  executeChoice?: ModelChoice;
  planFallback?: ModelChoice[];
  executeFallback?: ModelChoice[];
  extraProfiles?: ModelChoice[];
  overwrite: boolean;
}> {
  // If existing profiles.json has plan/execute, ask before overwriting
  if (detectExistingPlanOrExecute(configDir)) {
    const confirm = await clack.confirm({
      message: t('init.gatewaySetup.overwritePrompt'),
      initialValue: false,
    });
    handleCancel(confirm);
    if (!confirm) {
      return { overwrite: false };
    }
  }

  const choices = listChoices(endpoints);
  if (choices.length === 0) return { overwrite: true };

  const formatValue = (c: ModelChoice) => `${c.mode}:${c.model}`;
  const parseValue = (v: string): ModelChoice => {
    const colonIdx = v.indexOf(':');
    return { mode: v.substring(0, colonIdx), model: v.substring(colonIdx + 1) };
  };

  const options = choices.map(c => ({
    value: formatValue(c),
    label: `${c.mode} / ${c.model}`,
  }));

  // Default = first lexicographic entry (no tier inference).
  const firstChoiceValue = formatValue(choices[0]);

  const planSel = await clack.select({
    message: t('init.gatewaySetup.planPrompt'),
    options,
    initialValue: firstChoiceValue,
  });
  handleCancel(planSel);

  const execSel = await clack.select({
    message: t('init.gatewaySetup.executePrompt'),
    options,
    initialValue: firstChoiceValue,
  });
  handleCancel(execSel);

  const planChoice = parseValue(planSel as string);
  const execChoice = parseValue(execSel as string);

  // ── Fallback selection (multi-select, ordered) ──
  // Build fallback options excluding the primary choice. If no candidates remain (e.g. only
  // one discovered model), skip the prompt entirely.
  const planFallbackOptions = options.filter(o => o.value !== planSel);
  const execFallbackOptions = options.filter(o => o.value !== execSel);

  let planFallback: ModelChoice[] | undefined;
  if (planFallbackOptions.length > 0) {
    const sel = await clack.multiselect({
      message: t('init.gatewaySetup.planFallbackPrompt'),
      options: planFallbackOptions,
      required: false,
      initialValues: [],
    });
    handleCancel(sel);
    const arr = sel as string[];
    if (arr.length > 0) planFallback = arr.map(parseValue);
  }

  let executeFallback: ModelChoice[] | undefined;
  if (execFallbackOptions.length > 0) {
    const sel = await clack.multiselect({
      message: t('init.gatewaySetup.executeFallbackPrompt'),
      options: execFallbackOptions,
      required: false,
      initialValues: [],
    });
    handleCancel(sel);
    const arr = sel as string[];
    if (arr.length > 0) executeFallback = arr.map(parseValue);
  }

  // ── Extra profiles: additional models to register as standalone named profiles ──
  let extraProfiles: ModelChoice[] | undefined;
  if (options.length > 0) {
    const sel = await clack.multiselect({
      message: t('init.gatewaySetup.extraProfilesPrompt'),
      options,
      required: false,
      initialValues: [],
    });
    handleCancel(sel);
    const arr = sel as string[];
    if (arr.length > 0) extraProfiles = arr.map(parseValue);
  }

  return {
    planChoice,
    executeChoice: execChoice,
    planFallback,
    executeFallback,
    extraProfiles,
    overwrite: true,
  };
}

async function runGatewaySetup(
  backends: InitBackend[],
  paths: InitPaths,
  gatewayConfigDir?: string,
  answers?: Pick<InitAnswers, 'planChoice' | 'executeChoice' | 'extraProfiles'>,
): Promise<void> {
  // Discover endpoints from Claude/PI local configs — filtered by user-selected backends
  const endpoints = discoverEndpoints(backends);

  if (endpoints.length === 0) {
    clack.log.warn(t('init.gatewaySetup.noBackends'));
    clack.log.info(t('init.gatewaySetup.rerunHint'));
    return;
  }

  // Show discovered summary
  const summary = endpoints.map(ep =>
    `  ${ep.mode}/${ep.endpoint}: ${ep.models.slice(0, 3).join(', ')}${ep.models.length > 3 ? ', ...' : ''} (${ep.keys.length > 0 ? 'with key' : 'passthrough'})`,
  ).join('\n');
  clack.log.success(t('init.gatewaySetup.discovered', { count: endpoints.length, summary }));

  // Generate gateway.yaml — scoped to gatewayConfigDir when provided (test/alt env),
  // otherwise defaults to ~/.aistatus/gateway.yaml (production). Merge-aware: preserves
  // hand-maintained modes/keys and never drops previously-configured modes if discovery
  // under-reports (e.g. a transient `pi --list-models` failure).
  const { path: gatewayPath, result: mergeResult } = writeMergedGatewayYaml(endpoints, gatewayConfigDir);
  clack.log.success(t('init.gatewaySetup.gatewayWritten', { path: gatewayPath }));
  if (mergeResult.droppedFromDiscovery.length > 0) {
    const list = mergeResult.droppedFromDiscovery.map(p => `${p.mode}/${p.endpoint}`).join(', ');
    clack.log.warn(t('init.gatewaySetup.preservedModes', { count: mergeResult.droppedFromDiscovery.length, list }));
    clack.log.info(t('init.gatewaySetup.preservedModesHint'));
  }

  // Resolve plan/execute choices + fallback chains + extra profiles + overwrite intent.
  let planChoice = answers?.planChoice;
  let executeChoice = answers?.executeChoice;
  let planFallback: ModelChoice[] | undefined;
  let executeFallback: ModelChoice[] | undefined;
  let extraProfiles = answers?.extraProfiles;
  let overwrite: boolean;

  if (processStdin.isTTY) {
    // Interactive: prompt for selection (with overwrite confirmation if needed)
    const picked = await pickPlanExecuteInteractive(endpoints, paths.CONFIG_DIR);
    planChoice = picked.planChoice ?? planChoice;
    executeChoice = picked.executeChoice ?? executeChoice;
    planFallback = picked.planFallback;
    executeFallback = picked.executeFallback;
    extraProfiles = picked.extraProfiles ?? extraProfiles;
    overwrite = picked.overwrite;
  } else {
    // Non-interactive: stdin already provided choices (or empty → lex-first default).
    // Fallback chains are not configurable via stdin in this iteration — extend the stdin
    // protocol if scripted installs need fallback.
    overwrite = true;
  }

  // Generate profiles.json
  const profilesPath = writeProfilesJson(endpoints, {
    outputDir: paths.CONFIG_DIR,
    planChoice,
    executeChoice,
    planFallback,
    executeFallback,
    extraProfiles,
    overwrite,
  });
  clack.log.success(t('init.gatewaySetup.profilesWritten', { path: profilesPath }));

  // Show profile summary (reflects what was actually generated, not what was merged)
  const profiles = generateProfiles(endpoints, { planChoice, executeChoice, planFallback, executeFallback, extraProfiles });
  const profileNames = Object.keys(profiles.profiles).join(', ');
  clack.log.info(t('init.gatewaySetup.generatedProfiles', { names: profileNames, default: profiles.defaultProfile }));

  // Validate profile ↔ gateway mode coupling. A profile referencing a non-existent gateway mode is
  // exactly what produces a silent `400 Unknown mode: <x>` at runtime. Non-fatal — warn only.
  const issues = validateProfilesAgainstGateway(mergeResult.endpoints, paths.CONFIG_DIR);
  if (issues.length > 0) {
    const lines = issues.map(i => `  - ${i.profile}: ${i.reason}`).join('\n');
    clack.log.warn(t('init.gatewaySetup.profileIssues', { count: issues.length, lines }));
    clack.log.info(t('init.gatewaySetup.profileIssuesHint'));
  }
}

// ─── Main entry point ────────────────────────────────────────────

export interface InitOptions {
  homeDir?: string;
  force?: boolean;
  /** Override gateway.yaml output directory (defaults to ~/.aistatus/ when unset). */
  gatewayConfigDir?: string;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const paths = getResolvedPaths(options.homeDir);
  const force = options.force ?? false;

  // 1. Collect user choices
  const answers = processStdin.isTTY
    ? await collectAnswersInteractive(paths)
    : await collectAnswersNonInteractive();

  // 2. Check & install backends
  await checkAndInstallBackends(answers.backends);

  // 3. Ensure git + directory structure
  ensureGitInstalled();
  createDirectories(paths);
  ensureGitRepo(paths.DATA_DIR);

  // 4. Write configs
  writeDotEnv(paths, answers, force);
  copyDefaults(paths, force);
  deployHooks(paths, force);
  generateConfigs(paths, answers, force);
  seedSchedules(paths, answers, force);

  // 5. Gateway usage
  writeGatewayUsageConfig(answers.gatewayUsage, options.gatewayConfigDir);

  // 6. Service registration
  if (answers.installService) {
    installService(paths.DATA_DIR);
  }

  // 7. Gateway & profile auto-setup (detect from Claude/PI local configs)
  if (processStdin.isTTY) {
    const loginHints = answers.backends.map(b => {
      const info = BACKEND_INFO[b];
      return `  • ${t(info.labelKey)}:  ${t(info.loginHintKey).replace(/^Run /, '').replace(/\.$/, '')}`;
    }).join('\n');

    clack.note(
      t('init.gatewayProfile.note', { loginHints }),
      t('init.gatewayProfile.noteTitle'),
    );

    let gatewayDone = false;
    while (!gatewayDone) {
      const ready = await clack.confirm({
        message: t('init.gatewayProfile.readyPrompt'),
        initialValue: true,
      });
      handleCancel(ready);

      if (ready) {
        await runGatewaySetup(answers.backends, paths, options.gatewayConfigDir, answers);
        gatewayDone = true;
      } else {
        // User hasn't logged in yet — let them choose to go log in or skip entirely
        clack.log.info(t('init.gatewayProfile.loginNow', { loginHints }));
        const action = await clack.select({
          message: t('init.gatewayProfile.actionPrompt'),
          options: [
            { value: 'retry', label: t('init.gatewayProfile.retryLabel') },
            { value: 'skip', label: t('init.gatewayProfile.skipLabel') },
          ],
        });
        handleCancel(action);
        if (action === 'skip') {
          clack.log.info(t('init.gatewayProfile.skipped'));
          gatewayDone = true;
        }
        // action === 'retry' → loop continues, re-prompt the confirm
      }
    }
  } else {
    // Non-interactive: auto-detect silently, passing stdin-supplied choices
    try {
      await runGatewaySetup(answers.backends, paths, options.gatewayConfigDir, answers);
    } catch (e) {
      log.warn(`Gateway setup failed (non-interactive): ${(e as Error).message}`);
    }
  }

  // 8. Patch mode.json activeProfile to match profiles.json defaultProfile
  try {
    const profilesJsonPath = path.join(paths.CONFIG_DIR, 'profiles.json');
    const modeJsonPath = path.join(paths.STORE_DIR, 'mode.json');
    if (existsSync(profilesJsonPath) && existsSync(modeJsonPath)) {
      const profilesData = JSON.parse(readFileSync(profilesJsonPath, 'utf8'));
      const modeData = JSON.parse(readFileSync(modeJsonPath, 'utf8'));
      if (modeData.activeProfile === '__active__' && profilesData.defaultProfile) {
        modeData.activeProfile = profilesData.defaultProfile;
        writeFileSync(modeJsonPath, JSON.stringify(modeData));
        log.info(`mode.json activeProfile set to "${profilesData.defaultProfile}"`);
      }
    }
  } catch (e) {
    log.warn(`Failed to update activeProfile in mode.json: ${(e as Error).message}`);
  }

  // 9. Done
  clack.outro(t('init.outro', { dataDir: paths.DATA_DIR }));
}
