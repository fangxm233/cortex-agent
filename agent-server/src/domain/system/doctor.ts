import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenvLib } from 'dotenv';

import { withLegacyConnection } from '@core/connections-file.js';
import { isGitAvailable } from '@core/git-availability.js';
import { credentialInventory, routeName, SUBSCRIPTION_CONNECTION } from '../connections/index.js';
import { DATA_DIR, CONFIG_DIR, STORE_DIR, DAEMON_PID_FILE } from '@core/paths.js';
import { ensureAuthTokens, CLIENT_TOKEN_ENV, WEBHOOK_TOKEN_ENV } from '@core/auth.js';
import { generateMcpConfig } from '@core/config-generator.js';
import { isProcessAlive } from '@core/singleton-lock.js';
import {
  getAuthStatus as readAuthStatus,
  type AuthAccountStatus,
  type AuthStatusSnapshot,
} from '../auth/auth-status.js';
import { resolveConfiguredDefaultRun } from '../runs/config-resolver.js';
import { validateEngineSelection, validateModelRef } from '../agents/engine-selection.js';
import type { Backend } from '@core/types/agent-types.js';
import {
  loadPiRuntime as loadInstalledPiRuntime,
  PI_SDK_PACKAGE,
  type PiRuntimeLoadResult,
} from '../auth/pi-runtime.js';

// ─── Types ────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  /** Whether `applySafeFixes` can repair this issue idempotently. */
  fixable?: boolean;
}

export interface DoctorSection {
  title: string;
  checks: CheckResult[];
}

export interface DoctorReport {
  sections: DoctorSection[];
  counts: { pass: number; warn: number; fail: number; skip: number };
  /** True when no check failed (warnings/skips do not break ok). */
  ok: boolean;
}

/** Where the in-process PI SDK was found, and which version ships with this install. */
export interface PiSdkInfo {
  package: string;
  version: string | null;
}

export interface DoctorPaths {
  DATA_DIR: string;
  CONFIG_DIR: string;
  STORE_DIR: string;
}

/** Read-only environment probes — the diagnostic path never writes. */
export interface DoctorDeps {
  platform?: NodeJS.Platform;
  env: Record<string, string | undefined>;
  paths: DoctorPaths;
  nodeVersion: string;        // e.g. 'v20.11.0'
  requiredNodeMajor: number;  // e.g. 20
  fileExists(p: string): boolean;
  isWritable(p: string): boolean;
  readText(p: string): string | null;
  parseDotenv(text: string): Record<string, string>;
  commandExists(bin: string): boolean;
  pidAlive(pid: number): boolean;
  /** Locate the bundled PI SDK without importing it; null when it cannot be resolved. */
  resolvePiSdk(): PiSdkInfo | null;
  loadPiRuntime(): Promise<PiRuntimeLoadResult>;
  getAuthStatus(): Promise<AuthStatusSnapshot>;
  /** Backend and connection used by an unconfigured channel; null when unreadable. */
  defaultSelection(): DefaultSelectionInfo | null;
  /** Ids of the stored Claude connections a run can use: key connections and signed-in accounts. */
  claudeConnections(): string[];
}

export interface DefaultSelectionInfo {
  backend: Backend;
  /** The connection the selection runs on, resolved (never null for Claude). */
  connection: string | null;
}

/** Write actuators used only by `applySafeFixes` (idempotent, non-destructive). */
export interface FixActuators {
  mkdirp(p: string): void;
  ensureEnvFile(envPath: string): void;
  /** Generate any missing auth tokens, persist to envPath; return names generated. */
  ensureAuthTokens(envPath: string): string[];
  regenerateMcpConfig(): void;
}

export interface FixOutcome {
  id: string;
  label: string;
  applied: boolean;
  detail: string;
}

// ─── Helpers ──────────────────────────────────────────────────────

function normalize(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || t === 'null' || t === 'undefined') return undefined;
  return t;
}

function nodeMajor(version: string): number {
  const m = version.match(/^v?(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Merge process env over the .env file, normalizing blanks/null/undefined away. */
function buildEnvReader(deps: DoctorDeps): (name: string) => string | undefined {
  const envPath = path.join(deps.paths.CONFIG_DIR, '.env');
  let fileEnv: Record<string, string> = {};
  const text = deps.readText(envPath);
  if (text != null) {
    try { fileEnv = deps.parseDotenv(text); } catch { fileEnv = {}; }
  }
  return (name: string) => normalize(deps.env[name] ?? fileEnv[name]);
}

// ─── Section: Runtime & Process ───────────────────────────────────

/** The default selection's backend, else claude. PI runs in-process from the SDK bundled with
 *  this package, so only the Claude backend still needs a CLI on PATH. */
function backendRuntimeCheck(deps: DoctorDeps): CheckResult {
  const backend = deps.defaultSelection()?.backend ?? 'claude';
  if (backend === 'pi') {
    return { id: 'backend-runtime', label: 'Backend runtime', status: 'pass', detail: 'backend: pi runs in-process from the bundled SDK (no CLI needed)' };
  }
  return deps.commandExists('claude')
    ? { id: 'backend-runtime', label: 'Backend runtime', status: 'pass', detail: `claude found on PATH (backend: ${backend})` }
    : { id: 'backend-runtime', label: 'Backend runtime', status: 'warn', detail: `claude not on PATH (backend: ${backend})`, hint: 'Install/login the claude CLI' };
}

function gitRuntimeCheck(deps: DoctorDeps): CheckResult {
  if (deps.commandExists('git')) return { id: 'git', label: 'git', status: 'pass', detail: 'usable on PATH' };
  if ((deps.platform ?? process.platform) === 'win32') {
    return { id: 'git', label: 'git', status: 'fail', detail: 'unavailable', hint: 'Install Git for Windows — shell tools require Git Bash' };
  }
  return { id: 'git', label: 'git', status: 'warn', detail: 'unavailable (optional)', hint: 'Install Git to enable version history and Git-sourced extensions' };
}

function sectionRuntime(deps: DoctorDeps): DoctorSection {
  const checks: CheckResult[] = [];

  const major = nodeMajor(deps.nodeVersion);
  checks.push(major >= deps.requiredNodeMajor
    ? { id: 'node-version', label: 'Node version', status: 'pass', detail: `${deps.nodeVersion} (>=${deps.requiredNodeMajor})` }
    : { id: 'node-version', label: 'Node version', status: 'warn', detail: `${deps.nodeVersion} — Cortex requires Node >=${deps.requiredNodeMajor}`, hint: 'Upgrade Node.js' });

  checks.push(gitRuntimeCheck(deps));

  checks.push(backendRuntimeCheck(deps));

  // Daemon — informational only.
  const pidPath = path.join(deps.paths.STORE_DIR, path.basename(DAEMON_PID_FILE));
  const pidText = deps.fileExists(pidPath) ? deps.readText(pidPath) : null;
  const pid = pidText ? Number(pidText.trim()) : NaN;
  if (Number.isFinite(pid) && deps.pidAlive(pid)) {
    checks.push({ id: 'daemon', label: 'Daemon', status: 'pass', detail: `running (pid ${pid})` });
  } else {
    checks.push({ id: 'daemon', label: 'Daemon', status: 'skip', detail: 'not running', hint: 'Start with `cortex daemon`' });
  }

  return { title: 'Runtime & Process', checks };
}

// ─── Section: Backend Install / Login ─────────────────────────────

function pushDirectoryCheck(checks: CheckResult[], deps: DoctorDeps): void {
  const problems: string[] = [];
  for (const [name, p] of Object.entries(deps.paths)) {
    if (!deps.fileExists(p)) problems.push(`${name} missing (${p})`);
    else if (!deps.isWritable(p)) problems.push(`${name} not writable (${p})`);
  }
  checks.push(problems.length === 0
    ? { id: 'dirs', label: 'Data directories', status: 'pass', detail: 'present and writable' }
    : { id: 'dirs', label: 'Data directories', status: 'fail', detail: problems.join('; '), hint: 'run `cortex doctor --fix` or `cortex init`', fixable: true });
}

function pushEnvAndTokenChecks(
  checks: CheckResult[],
  deps: DoctorDeps,
  getEnv: (name: string) => string | undefined,
): void {
  const envPath = path.join(deps.paths.CONFIG_DIR, '.env');
  checks.push(deps.fileExists(envPath)
    ? { id: 'env-file', label: '.env file', status: 'pass', detail: envPath }
    : { id: 'env-file', label: '.env file', status: 'fail', detail: `missing (${envPath})`, hint: 'run `cortex init`' });
  const missing = [CLIENT_TOKEN_ENV, WEBHOOK_TOKEN_ENV].filter(name => !getEnv(name));
  checks.push(missing.length === 0
    ? { id: 'auth-tokens', label: 'Auth tokens', status: 'pass', detail: 'client + webhook tokens set' }
    : { id: 'auth-tokens', label: 'Auth tokens', status: 'fail', detail: `missing: ${missing.join(', ')}`, hint: 'run `cortex doctor --fix` to generate', fixable: true });
}

/** The stored connection (key or account) the default Claude selection runs on; null for the
 *  subscription, PI, or an unreadable default. */
function defaultClaudeKeyConnection(deps: DoctorDeps): string | null {
  const selection = deps.defaultSelection();
  if (selection?.backend !== 'claude' || !selection.connection) return null;
  return selection.connection === SUBSCRIPTION_CONNECTION ? null : selection.connection;
}

/** A default on an existing key connection or signed-in account needs no default Claude login. */
function keyConnectionBacked(deps: DoctorDeps): boolean {
  const id = defaultClaudeKeyConnection(deps);
  return id !== null && deps.claudeConnections().includes(id);
}

function pushClaudeConnectionCheck(checks: CheckResult[], deps: DoctorDeps): void {
  const id = defaultClaudeKeyConnection(deps);
  if (id === null) {
    checks.push({ id: 'claude-connection', label: 'Claude connection', status: 'skip', detail: 'default does not use a key connection' });
  } else if (deps.claudeConnections().includes(id)) {
    checks.push({ id: 'claude-connection', label: 'Claude connection', status: 'pass', detail: `${id} configured` });
  } else {
    checks.push({ id: 'claude-connection', label: 'Claude connection', status: 'warn', detail: `${id} is not configured`, hint: 'add the connection in Settings or pick another model' });
  }
}

function pushConfigChecks(checks: CheckResult[], deps: DoctorDeps): void {
  const { CONFIG_DIR: config, STORE_DIR: store } = deps.paths;
  const statePath = path.join(store, 'agent-state.json');
  const stateLabel = deps.fileExists(statePath) ? 'agent-state.json' : 'mode.json';
  pushJsonCheck(
    checks, deps,
    deps.fileExists(statePath) ? statePath : path.join(store, 'mode.json'),
    'mode-json', stateLabel, 'warn',
  );
  checks.push(checkModels(deps, path.join(config, 'models.json')));
  const mcpPath = path.join(config, 'mcp-config.json');
  if (!deps.fileExists(mcpPath)) {
    checks.push({ id: 'mcp-config', label: 'mcp-config.json', status: 'warn', detail: `missing (${mcpPath})`, hint: 'run `cortex doctor --fix` to regenerate', fixable: true });
  } else if (!isValidJson(deps.readText(mcpPath))) {
    checks.push({ id: 'mcp-config', label: 'mcp-config.json', status: 'warn', detail: 'invalid JSON', hint: 'run `cortex doctor --fix` to regenerate', fixable: true });
  } else {
    checks.push({ id: 'mcp-config', label: 'mcp-config.json', status: 'pass', detail: 'valid' });
  }
}

const BACKEND_DOC_HINT = 'See docs/backends.md#remote-login';
const UNHEALTHY_AUTH_STATES = new Set(['expired', 'logged-out']);

const PI_SDK_HINT = 'Reinstall the Cortex server package — the PI SDK ships with it';

async function checkPiRuntime(deps: DoctorDeps): Promise<CheckResult> {
  const sdk = deps.resolvePiSdk();
  if (!sdk) {
    return {
      id: 'pi-runtime', label: 'PI runtime', status: 'warn',
      detail: `bundled PI SDK not resolvable (${PI_SDK_PACKAGE})`, hint: PI_SDK_HINT,
    };
  }
  try {
    const result = await deps.loadPiRuntime();
    if (result.available && typeof result.runtime.login === 'function') {
      const version = result.version ?? sdk.version;
      const suffix = version ? ` ${version}` : '';
      return {
        id: 'pi-runtime', label: 'PI runtime', status: 'pass',
        detail: `in-process SDK ${sdk.package}${suffix}; login export found`,
      };
    }
  } catch {
    // Report the stable diagnostic only; dependency errors may contain sensitive paths or values.
  }
  return {
    id: 'pi-runtime', label: 'PI runtime', status: 'warn',
    detail: 'bundled PI runtime or login export unavailable', hint: BACKEND_DOC_HINT,
  };
}

function keyConnectionCovered(account: AuthAccountStatus, connectionBacked: boolean): boolean {
  return connectionBacked
    && (account.connection ?? null) === null
    && account.backend === 'claude'
    && account.provider === 'anthropic'
    && account.state === 'logged-out';
}

function backendAuthSummary(
  snapshot: AuthStatusSnapshot,
  connectionBacked: boolean,
): CheckResult {
  const inUse = snapshot.accounts.filter(account => account.inUse);
  const covered = inUse.filter(account => keyConnectionCovered(account, connectionBacked));
  const unhealthy = inUse.filter(account => (
    UNHEALTHY_AUTH_STATES.has(account.state) && !keyConnectionCovered(account, connectionBacked)
  ));
  const providers = [...new Set(unhealthy.map(account => account.provider))].sort();
  if (unhealthy.length > 0) {
    return {
      id: 'backend-auth', label: 'Backend authentication', status: 'warn',
      detail: `${inUse.length} in use; ${unhealthy.length} expired or logged out: ${providers.join(', ')}`,
      hint: BACKEND_DOC_HINT,
    };
  }
  const keyed = covered.length > 0 ? '; on a key connection: anthropic' : '';
  return {
    id: 'backend-auth', label: 'Backend authentication', status: 'pass',
    detail: `${inUse.length} in use; 0 expired or logged out${keyed}`,
  };
}

async function checkBackendAuth(
  deps: DoctorDeps,
  connectionBacked: boolean,
): Promise<CheckResult> {
  try {
    return backendAuthSummary(await deps.getAuthStatus(), connectionBacked);
  } catch {
    return {
      id: 'backend-auth', label: 'Backend authentication', status: 'warn',
      detail: 'authentication summary unavailable', hint: BACKEND_DOC_HINT,
    };
  }
}

async function sectionBackend(
  deps: DoctorDeps,
  getEnv: (name: string) => string | undefined,
): Promise<DoctorSection> {
  const checks: CheckResult[] = [];
  pushDirectoryCheck(checks, deps);
  pushEnvAndTokenChecks(checks, deps, getEnv);
  pushClaudeConnectionCheck(checks, deps);
  pushConfigChecks(checks, deps);
  checks.push(...await Promise.all([
    checkPiRuntime(deps), checkBackendAuth(deps, keyConnectionBacked(deps)),
  ]));
  return { title: 'Backend Install / Login', checks };
}

function isValidJson(text: string | null): boolean {
  if (text == null) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

function pushJsonCheck(checks: CheckResult[], deps: DoctorDeps, p: string, id: string, label: string, missingStatus: CheckStatus): void {
  if (!deps.fileExists(p)) {
    checks.push({ id, label, status: missingStatus, detail: `missing (${p})` });
    return;
  }
  checks.push(isValidJson(deps.readText(p))
    ? { id, label, status: 'pass', detail: 'valid' }
    : { id, label, status: missingStatus, detail: 'invalid JSON' });
}

function checkModels(deps: DoctorDeps, p: string): CheckResult {
  const base = { id: 'models', label: 'models.json' };
  if (!deps.fileExists(p)) {
    return { ...base, status: 'warn', detail: `missing (${p})`, hint: 'run `cortex init`' };
  }
  try {
    const parsed = JSON.parse(deps.readText(p) ?? '') as { default?: unknown; favorites?: unknown } | null;
    if (parsed?.default) parsed.default = withLegacyConnection(parsed.default);
    validateEngineSelection(parsed?.default);
    if (!Array.isArray(parsed?.favorites)) throw new Error('missing `favorites` array');
    parsed.favorites.forEach(validateModelRef);
    return { ...base, status: 'pass', detail: `default: ${parsed.default.model}; favorites: ${parsed.favorites.length}` };
  } catch (error) {
    return { ...base, status: 'fail', detail: (error as Error).message, hint: 're-run `cortex init`' };
  }
}

// ─── Section: Messaging Platform ──────────────────────────────────

function sectionPlatform(deps: DoctorDeps, getEnv: (n: string) => string | undefined): DoctorSection {
  const checks: CheckResult[] = [];
  const raw = getEnv('CORTEX_PLATFORM') ?? 'slack';
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  checks.push({ id: 'platform', label: 'Platform', status: 'pass', detail: `configured: ${names.join(', ') || '(none)'}` });

  for (const name of names) {
    if (name === 'slack') {
      const problems: string[] = [];
      const bot = getEnv('SLACK_BOT_TOKEN');
      const sign = getEnv('SLACK_SIGNING_SECRET');
      const app = getEnv('SLACK_APP_TOKEN');
      if (!bot) problems.push('SLACK_BOT_TOKEN missing');
      else if (!bot.startsWith('xoxb-')) problems.push('SLACK_BOT_TOKEN should start with xoxb-');
      if (!sign) problems.push('SLACK_SIGNING_SECRET missing');
      if (!app) problems.push('SLACK_APP_TOKEN missing');
      else if (!app.startsWith('xapp-')) problems.push('SLACK_APP_TOKEN should start with xapp-');
      checks.push(problems.length === 0
        ? { id: 'slack-creds', label: 'Slack credentials', status: 'pass', detail: 'bot / signing / app tokens present' }
        : { id: 'slack-creds', label: 'Slack credentials', status: 'fail', detail: problems.join('; '), hint: 'set Slack tokens in .env (see `cortex init`)' });
    } else if (name === 'feishu') {
      const problems: string[] = [];
      if (!getEnv('FEISHU_APP_ID')) problems.push('FEISHU_APP_ID missing');
      if (!getEnv('FEISHU_APP_SECRET')) problems.push('FEISHU_APP_SECRET missing');
      checks.push(problems.length === 0
        ? { id: 'feishu-creds', label: 'Feishu credentials', status: 'pass', detail: 'app id / secret present' }
        : { id: 'feishu-creds', label: 'Feishu credentials', status: 'fail', detail: problems.join('; '), hint: 'set FEISHU_APP_ID / FEISHU_APP_SECRET in .env' });
    } else if (name === 'test') {
      checks.push({ id: 'test-platform', label: 'Test platform', status: 'skip', detail: 'mock adapter (test only)' });
    } else {
      checks.push({ id: `platform-${name}`, label: `Platform: ${name}`, status: 'warn', detail: 'unknown platform name' });
    }
  }

  return { title: 'Messaging Platform', checks };
}

// ─── Engine ───────────────────────────────────────────────────────

export async function runDiagnostics(deps: DoctorDeps): Promise<DoctorReport> {
  const getEnv = buildEnvReader(deps);
  const sections: DoctorSection[] = [
    sectionRuntime(deps),
    await sectionBackend(deps, getEnv),
    sectionPlatform(deps, getEnv),
  ];

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const s of sections) for (const c of s.checks) counts[c.status]++;

  return { sections, counts, ok: counts.fail === 0 };
}

// ─── Safe fixes ───────────────────────────────────────────────────

export async function applySafeFixes(report: DoctorReport, deps: DoctorDeps, fix: FixActuators): Promise<FixOutcome[]> {
  const fixable = new Map<string, CheckResult>();
  for (const s of report.sections) for (const c of s.checks) {
    if (c.fixable && (c.status === 'fail' || c.status === 'warn')) fixable.set(c.id, c);
  }

  const outcomes: FixOutcome[] = [];
  const envPath = path.join(deps.paths.CONFIG_DIR, '.env');

  if (fixable.has('dirs')) {
    for (const p of [deps.paths.DATA_DIR, deps.paths.CONFIG_DIR, deps.paths.STORE_DIR]) fix.mkdirp(p);
    outcomes.push({ id: 'dirs', label: 'Data directories', applied: true, detail: 'created missing directories' });
  }

  if (fixable.has('auth-tokens')) {
    fix.ensureEnvFile(envPath);
    const generated = fix.ensureAuthTokens(envPath);
    outcomes.push({ id: 'auth-tokens', label: 'Auth tokens', applied: generated.length > 0, detail: generated.length > 0 ? `generated: ${generated.join(', ')}` : 'already present' });
  }

  if (fixable.has('mcp-config')) {
    fix.regenerateMcpConfig();
    outcomes.push({ id: 'mcp-config', label: 'mcp-config.json', applied: true, detail: 'regenerated' });
  }

  return outcomes;
}

// ─── Default real-environment wiring ──────────────────────────────

function commandExistsOnPath(bin: string): boolean {
  if (bin === 'git') return isGitAvailable();
  const pathVar = process.env.PATH || '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try { if (fs.existsSync(candidate)) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * Locate the bundled PI SDK by resolving its entry and reading the owning package manifest.
 * Resolution alone is the signal doctor needs — importing the entry costs ~100 MB RSS, and
 * `loadPiRuntime` already pays that price when it exercises the runtime.
 */
function resolveBundledPiSdk(): PiSdkInfo | null {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.resolve(PI_SDK_PACKAGE)));
  } catch {
    return null;
  }
  for (;;) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (parsed?.name === PI_SDK_PACKAGE) {
        return { package: PI_SDK_PACKAGE, version: typeof parsed.version === 'string' ? parsed.version : null };
      }
    } catch { /* keep walking up to the package root */ }
    const parent = path.dirname(dir);
    if (parent === dir) return { package: PI_SDK_PACKAGE, version: null };
    dir = parent;
  }
}

export function createDefaultDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    paths: { DATA_DIR, CONFIG_DIR, STORE_DIR },
    nodeVersion: process.version,
    requiredNodeMajor: 20,
    fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    isWritable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    parseDotenv: (t) => parseDotenvLib(t) as Record<string, string>,
    commandExists: commandExistsOnPath,
    pidAlive: isProcessAlive,
    resolvePiSdk: resolveBundledPiSdk,
    loadPiRuntime: () => loadInstalledPiRuntime(),
    getAuthStatus: () => readAuthStatus(),
    defaultSelection: readDefaultSelection,
    claudeConnections: () => credentialInventory.claudeConnections()
      .filter((view) => view.kind === 'key' || view.kind === 'account').map((view) => view.id),
  };
}

function readDefaultSelection(): DefaultSelectionInfo | null {
  try {
    const selection = resolveConfiguredDefaultRun();
    if (!selection) return null;
    return { backend: selection.backend, connection: selection.backend === 'claude' ? routeName(selection) : null };
  } catch {
    return null;
  }
}

export function createDefaultFixActuators(): FixActuators {
  return {
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    ensureEnvFile: (envPath) => {
      if (!fs.existsSync(envPath)) {
        fs.mkdirSync(path.dirname(envPath), { recursive: true });
        fs.writeFileSync(envPath, '');
      }
    },
    ensureAuthTokens: (envPath) => ensureAuthTokens({ envPath }).generated,
    regenerateMcpConfig: () => generateMcpConfig(),
  };
}
