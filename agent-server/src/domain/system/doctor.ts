// input:  Environment, filesystem, gateway, auth, and PI probes
// output: Doctor reports, default probes, and safe-fix actuators
// pos:    Runs install-wide health diagnostics for cortex doctor
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { parse as parseDotenvLib } from 'dotenv';

import { DATA_DIR, CONFIG_DIR, STORE_DIR, GATEWAY_MANAGED_KEY_PLACEHOLDER } from '@core/utils.js';
import { ensureAuthTokens, CLIENT_TOKEN_ENV, WEBHOOK_TOKEN_ENV } from '@core/auth.js';
import { generateMcpConfig } from '@core/config-generator.js';
import {
  getAuthStatus as readAuthStatus,
  type AuthAccountStatus,
  type AuthStatusSnapshot,
} from '../auth/auth-status.js';
import {
  loadPiRuntime as loadInstalledPiRuntime,
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

export interface DoctorPaths {
  DATA_DIR: string;
  CONFIG_DIR: string;
  STORE_DIR: string;
}

/** Read-only environment probes — the diagnostic path never writes. */
export interface DoctorDeps {
  env: Record<string, string | undefined>;
  paths: DoctorPaths;
  homeDir: string;
  nodeVersion: string;        // e.g. 'v20.11.0'
  requiredNodeMajor: number;  // e.g. 20
  fileExists(p: string): boolean;
  isWritable(p: string): boolean;
  readText(p: string): string | null;
  parseDotenv(text: string): Record<string, string>;
  commandExists(bin: string): boolean;
  pidAlive(pid: number): boolean;
  probeGateway(): Promise<boolean>;
  loadPiRuntime(): Promise<PiRuntimeLoadResult>;
  getAuthStatus(): Promise<AuthStatusSnapshot>;
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

const GW_HOST = '127.0.0.1';
const GW_PORT = 9880;

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

function sectionRuntime(deps: DoctorDeps): DoctorSection {
  const checks: CheckResult[] = [];

  const major = nodeMajor(deps.nodeVersion);
  checks.push(major >= deps.requiredNodeMajor
    ? { id: 'node-version', label: 'Node version', status: 'pass', detail: `${deps.nodeVersion} (>=${deps.requiredNodeMajor})` }
    : { id: 'node-version', label: 'Node version', status: 'warn', detail: `${deps.nodeVersion} — Cortex requires Node >=${deps.requiredNodeMajor}`, hint: 'Upgrade Node.js' });

  checks.push(deps.commandExists('git')
    ? { id: 'git', label: 'git', status: 'pass', detail: 'found on PATH' }
    : { id: 'git', label: 'git', status: 'fail', detail: 'not found on PATH', hint: 'Install git — required for context sync' });

  // Backend binary, per mode.json backend selection.
  const modeText = deps.readText(path.join(deps.paths.STORE_DIR, 'mode.json'));
  let backend = 'claude';
  try { if (modeText) { const m = JSON.parse(modeText); if (typeof m.backend === 'string') backend = m.backend; } } catch { /* fall back to claude */ }
  const bin = backend === 'pi' ? 'pi' : 'claude';
  checks.push(deps.commandExists(bin)
    ? { id: 'backend-binary', label: 'Backend binary', status: 'pass', detail: `${bin} found on PATH (backend: ${backend})` }
    : { id: 'backend-binary', label: 'Backend binary', status: 'warn', detail: `${bin} not on PATH (backend: ${backend})`, hint: `Install/login the ${bin} CLI` });

  // Daemon — informational only.
  const pidPath = path.join(deps.paths.STORE_DIR, 'daemon.pid');
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

function usesClaudeApiMode(deps: DoctorDeps): boolean {
  try {
    const parsed = JSON.parse(deps.readText(path.join(deps.paths.STORE_DIR, 'mode.json')) ?? '');
    return parsed.claudeMode === 'api'
      || (parsed.backend === 'claude' && parsed.mode === 'api');
  } catch {
    return false;
  }
}

function gatewayBacksClaudeApi(
  deps: DoctorDeps,
  getEnv: (name: string) => string | undefined,
  gatewayHealthy: boolean,
): boolean {
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  const localKeyMissing = !apiKey || apiKey === GATEWAY_MANAGED_KEY_PLACEHOLDER;
  return gatewayHealthy && localKeyMissing && usesClaudeApiMode(deps);
}

function pushAnthropicKeyCheck(
  checks: CheckResult[],
  getEnv: (name: string) => string | undefined,
  gatewayBacked: boolean,
): void {
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (gatewayBacked) {
    checks.push({ id: 'anthropic-key', label: 'Anthropic API key', status: 'pass', detail: 'managed by healthy gateway' });
  } else if (apiKey) {
    const detail = apiKey === GATEWAY_MANAGED_KEY_PLACEHOLDER ? 'managed by gateway' : 'set';
    checks.push({ id: 'anthropic-key', label: 'Anthropic API key', status: 'pass', detail });
  } else {
    checks.push({ id: 'anthropic-key', label: 'Anthropic API key', status: 'warn', detail: 'not set — required for API mode (plan/subscription mode can ignore)', hint: 'set ANTHROPIC_API_KEY in .env or run `cortex init`' });
  }
}

function pushConfigChecks(checks: CheckResult[], deps: DoctorDeps): void {
  const { CONFIG_DIR: config, STORE_DIR: store } = deps.paths;
  pushJsonCheck(checks, deps, path.join(store, 'mode.json'), 'mode-json', 'mode.json', 'warn');
  checks.push(checkProfiles(deps, path.join(config, 'profiles.json')));
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

async function checkPiRuntime(deps: DoctorDeps): Promise<CheckResult> {
  if (!deps.commandExists('pi')) {
    return { id: 'pi-runtime', label: 'PI runtime', status: 'skip', detail: 'pi not installed' };
  }
  try {
    const result = await deps.loadPiRuntime();
    if (result.available && typeof result.runtime.login === 'function') {
      const version = result.version ? ` (${result.version})` : '';
      return { id: 'pi-runtime', label: 'PI runtime', status: 'pass', detail: `available${version}; login export found` };
    }
  } catch {
    // Report the stable diagnostic only; dependency errors may contain sensitive paths or values.
  }
  return {
    id: 'pi-runtime', label: 'PI runtime', status: 'warn',
    detail: 'installed PI runtime or login export unavailable', hint: BACKEND_DOC_HINT,
  };
}

function gatewayCovered(account: AuthAccountStatus, gatewayBacked: boolean): boolean {
  return gatewayBacked
    && account.backend === 'claude'
    && account.provider === 'anthropic'
    && account.state === 'logged-out';
}

function backendAuthSummary(
  snapshot: AuthStatusSnapshot,
  gatewayBacked: boolean,
): CheckResult {
  const inUse = snapshot.accounts.filter(account => account.inUse);
  const covered = inUse.filter(account => gatewayCovered(account, gatewayBacked));
  const unhealthy = inUse.filter(account => (
    UNHEALTHY_AUTH_STATES.has(account.state) && !gatewayCovered(account, gatewayBacked)
  ));
  const providers = [...new Set(unhealthy.map(account => account.provider))].sort();
  if (unhealthy.length > 0) {
    return {
      id: 'backend-auth', label: 'Backend authentication', status: 'warn',
      detail: `${inUse.length} in use; ${unhealthy.length} expired or logged out: ${providers.join(', ')}`,
      hint: BACKEND_DOC_HINT,
    };
  }
  const gateway = covered.length > 0 ? '; gateway-backed: anthropic' : '';
  return {
    id: 'backend-auth', label: 'Backend authentication', status: 'pass',
    detail: `${inUse.length} in use; 0 expired or logged out${gateway}`,
  };
}

async function checkBackendAuth(
  deps: DoctorDeps,
  gatewayBacked: boolean,
): Promise<CheckResult> {
  try {
    return backendAuthSummary(await deps.getAuthStatus(), gatewayBacked);
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
  gatewayHealthy: boolean,
): Promise<DoctorSection> {
  const checks: CheckResult[] = [];
  const gatewayBacked = gatewayBacksClaudeApi(deps, getEnv, gatewayHealthy);
  pushDirectoryCheck(checks, deps);
  pushEnvAndTokenChecks(checks, deps, getEnv);
  pushAnthropicKeyCheck(checks, getEnv, gatewayBacked);
  pushConfigChecks(checks, deps);
  checks.push(...await Promise.all([
    checkPiRuntime(deps), checkBackendAuth(deps, gatewayBacked),
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

function checkProfiles(deps: DoctorDeps, p: string): CheckResult {
  if (!deps.fileExists(p)) {
    return { id: 'profiles', label: 'profiles.json', status: 'warn', detail: `missing (${p})`, hint: 'run `cortex setup-gateway`' };
  }
  const text = deps.readText(p);
  let parsed: any;
  try { parsed = JSON.parse(text ?? ''); } catch {
    return { id: 'profiles', label: 'profiles.json', status: 'fail', detail: 'invalid JSON', hint: 're-run `cortex setup-gateway`' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.profiles !== 'object' || parsed.profiles == null) {
    return { id: 'profiles', label: 'profiles.json', status: 'fail', detail: 'missing `profiles` object' };
  }
  if (parsed.defaultProfile && !(parsed.defaultProfile in parsed.profiles)) {
    return { id: 'profiles', label: 'profiles.json', status: 'fail', detail: `defaultProfile "${parsed.defaultProfile}" not found in profiles` };
  }
  const names = Object.keys(parsed.profiles).join(', ');
  return { id: 'profiles', label: 'profiles.json', status: 'pass', detail: `profiles: ${names || '(none)'}` };
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

// ─── Section: Gateway ─────────────────────────────────────────────

function sectionGateway(
  deps: DoctorDeps,
  getEnv: (name: string) => string | undefined,
  healthy: boolean,
): DoctorSection {
  const checks: CheckResult[] = [];
  const gwYaml = path.join(deps.homeDir, '.aistatus', 'gateway.yaml');
  const gwConfigured = deps.fileExists(gwYaml);
  checks.push(gwConfigured
    ? { id: 'gateway-config', label: 'Gateway config', status: 'pass', detail: gwYaml }
    : { id: 'gateway-config', label: 'Gateway config', status: 'skip', detail: 'not configured (no ~/.aistatus/gateway.yaml)', hint: 'run `cortex setup-gateway` if you use the gateway' });

  const gatewayInUse = getEnv('ANTHROPIC_API_KEY') === GATEWAY_MANAGED_KEY_PLACEHOLDER || gwConfigured;
  if (healthy) {
    checks.push({ id: 'gateway-health', label: 'Gateway health', status: 'pass', detail: `responding at ${GW_HOST}:${GW_PORT}` });
  } else if (gatewayInUse) {
    checks.push({ id: 'gateway-health', label: 'Gateway health', status: 'fail', detail: `no response at ${GW_HOST}:${GW_PORT}/status`, hint: 'check gateway.log or restart Cortex (the server auto-starts the gateway)' });
  } else {
    checks.push({ id: 'gateway-health', label: 'Gateway health', status: 'skip', detail: 'not running (not required for current backend)' });
  }

  return { title: 'Gateway', checks };
}

// ─── Engine ───────────────────────────────────────────────────────

export async function runDiagnostics(deps: DoctorDeps): Promise<DoctorReport> {
  const getEnv = buildEnvReader(deps);
  const gatewayHealthy = await deps.probeGateway();
  const sections: DoctorSection[] = [
    sectionRuntime(deps),
    await sectionBackend(deps, getEnv, gatewayHealthy),
    sectionPlatform(deps, getEnv),
    sectionGateway(deps, getEnv, gatewayHealthy),
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

function probeGatewayHttp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${GW_HOST}:${GW_PORT}/status`, { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export function createDefaultDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    paths: { DATA_DIR, CONFIG_DIR, STORE_DIR },
    homeDir: os.homedir(),
    nodeVersion: process.version,
    requiredNodeMajor: 20,
    fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    isWritable: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } },
    readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    parseDotenv: (t) => parseDotenvLib(t) as Record<string, string>,
    commandExists: commandExistsOnPath,
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    probeGateway: probeGatewayHttp,
    loadPiRuntime: () => loadInstalledPiRuntime(),
    getAuthStatus: () => readAuthStatus(),
  };
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
