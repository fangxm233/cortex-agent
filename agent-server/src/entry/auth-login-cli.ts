// input:  auth status, shared login service, terminal interaction
// output: runAuthLoginCli and injectable login coordination
// pos:    TTY provider login without a running daemon
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { randomUUID } from 'node:crypto';
import { formatHelp } from '@core/cli-utils.js';
import { setProcessLogPolicy } from '@core/log.js';
import { getAuthStatus, type AuthStatusSnapshot } from '@domain/auth/auth-status.js';
import { authLoginService, type AuthLoginService } from '@domain/auth/login-service.js';
import type { LoginFlowState, StartLoginFlowInput } from '@domain/auth/login-flow.js';
import { syncGatewayFromBackends, type GatewaySyncResult } from '@domain/auth/gateway-sync.js';
import { createLoginTerminal, ensureClaudeForLogin, type LoginTerminal } from './auth-login-terminal.js';
import type { AuthCliResult } from './auth-cli.js';

export interface LoginCliDeps {
  tty: boolean;
  readStatus: () => Promise<AuthStatusSnapshot>;
  ui: LoginTerminal;
  service: AuthLoginService;
  ensureClaude: () => Promise<boolean>;
  sync: (backend: string) => Promise<GatewaySyncResult>;
}
type Options = Partial<Pick<StartLoginFlowInput, 'backend' | 'provider' | 'authType'>>;
export class LoginCliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}
export function loginHelp(): string {
  return formatHelp({ name: 'cortex auth login', description: 'Login interactively; credentials are detected locally, not inference-tested.', usage: 'cortex auth login [--backend pi|claude] [--provider ID] [--auth-type oauth|api_key]', options: [
    { flag: '--backend pi|claude', description: 'Backend (default: select; PI is bundled)' },
    { flag: '--provider ID', description: 'Provider (default: select from runtime)' },
    { flag: '--auth-type oauth|api_key', description: 'Authentication (default: select supported type)' },
    { flag: '--help, -h', description: 'Show help' },
  ], examples: [{ description: 'Select a provider', command: 'cortex auth login' }, { description: 'Claude subscription', command: 'cortex auth login --backend claude --provider anthropic --auth-type oauth' }] });
}
function parseOptions(args: string[]): Options {
  const result: Record<string, string> = {};
  const flags: Record<string, string> = { '--backend': 'backend', '--provider': 'provider', '--auth-type': 'authType' };
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--') || result[key]) throw new LoginCliError('Invalid login options. Use cortex auth login --help; keys/codes must not be command arguments.');
    result[key] = args[i + 1];
  }
  if (result.backend && !['pi', 'claude'].includes(result.backend)) throw new LoginCliError('Invalid --backend. Valid values: pi, claude.');
  if (result.authType && !['oauth', 'api_key'].includes(result.authType)) throw new LoginCliError('Invalid --auth-type. Valid values: oauth, api_key.');
  return result as Options;
}
async function selectInput(options: Options, deps: LoginCliDeps): Promise<StartLoginFlowInput> {
  const backend = options.backend ?? await deps.ui.select('Backend', [{ value: 'pi', label: 'PI · bundled' }, { value: 'claude', label: 'Claude Code' }]) as 'pi' | 'claude';
  const snapshot = await deps.readStatus();
  const accounts = snapshot.accounts.filter(a => a.backend === backend && a.capabilities.length);
  const provider = options.provider ?? await deps.ui.select('Provider', accounts.map(a => ({ value: a.provider, label: `${a.label} (${a.state})` })));
  const account = accounts.find(a => a.provider === provider);
  if (!account) throw new LoginCliError('Provider unavailable. Run cortex auth status or select a runtime-supported provider.');
  const authType = options.authType ?? await deps.ui.select('Authentication', account.capabilities.map(value => ({ value, label: value }))) as StartLoginFlowInput['authType'];
  if (!account.capabilities.includes(authType)) throw new LoginCliError(`Unsupported authentication. Valid values: ${account.capabilities.join(', ')}.`);
  if (backend === 'claude' && !await deps.ensureClaude()) throw new LoginCliError('Claude Code installation declined. Run cortex auth login to retry.', 130);
  return { backend, provider, authType, channel: 'cli', sessionId: randomUUID() };
}
async function answerPrompt(state: LoginFlowState, deps: LoginCliDeps): Promise<LoginFlowState> {
  const prompt = state.pendingPrompt!;
  const signal = AbortSignal.timeout(Math.max(1, Date.parse(state.expiresAt) - Date.now()));
  const value = prompt.kind === 'select'
    ? await deps.ui.select(prompt.message, (prompt.options ?? []).map(o => ({ value: o.id, label: o.label })), signal)
    : await deps.ui.secret(prompt.message, signal);
  return deps.service.respond(state.flowId, value);
}
async function driveFlow(initial: LoginFlowState, deps: LoginCliDeps, signal: AbortSignal): Promise<LoginFlowState> {
  let state = initial;
  let notice = '';
  while (!['done', 'failed', 'cancelled'].includes(state.step)) {
    if (signal.aborted) throw new LoginCliError('Login cancelled. Run cortex auth login to retry.', 130);
    if (Date.now() >= Date.parse(state.expiresAt)) throw new LoginCliError('Login expired. Run cortex auth login to retry.');
    const nextNotice = JSON.stringify(state.notice);
    if (state.notice && notice !== nextNotice) deps.ui.notify(state.notice);
    notice = nextNotice;
    if (state.pendingPrompt) { state = await answerPrompt(state, deps); continue; }
    await new Promise(resolve => setTimeout(resolve, 150));
    const next = deps.service.getState(state.flowId);
    if (!next) throw new LoginCliError('Login expired. Run cortex auth login to retry.');
    state = next;
  }
  return state;
}
async function login(options: Options, deps: LoginCliDeps): Promise<AuthCliResult> {
  const input = await selectInput(options, deps);
  const initial = await deps.service.start(input);
  let state: LoginFlowState;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try { state = await driveFlow(initial, deps, controller.signal); }
  catch (error) { await deps.service.cancel(initial.flowId).catch(() => {}); throw error; }
  finally { process.removeListener('SIGINT', interrupt); }
  if (state.step !== 'done') throw new LoginCliError(`Login ${state.step}. Run cortex auth login to retry.`, state.step === 'cancelled' ? 130 : 1);
  const sync = await deps.sync(input.backend);
  return { exitCode: 0, stderr: '', stdout: JSON.stringify({ ok: true, backend: input.backend, provider: input.provider, authType: input.authType, state: 'done', sync, inferenceVerified: false }) };
}
export function defaultLoginDeps(): LoginCliDeps {
  const ui = createLoginTerminal();
  return { tty: !!process.stdin.isTTY && !!process.stderr.isTTY, readStatus: getAuthStatus, ui, service: authLoginService, ensureClaude: () => ensureClaudeForLogin(ui), sync: async backend => {
    const result = await syncGatewayFromBackends({ backends: [backend] });
    return { ...result, reason: result.reason && result.reason !== 'no-endpoints' ? 'sync-failed' : result.reason };
  } };
}
export async function runAuthLoginCli(args: string[], deps = defaultLoginDeps()): Promise<AuthCliResult> {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: loginHelp(), stderr: '' };
  const restoreLog = setProcessLogPolicy({ consoleToStderr: true, files: false, console: false });
  try {
    const options = parseOptions(args);
    if (!deps.tty) throw new LoginCliError('Login requires an interactive terminal. Run cortex auth login in a TTY, or use the Accounts page.');
    return await login(options, deps);
  } catch (error) {
    const safe = error instanceof LoginCliError ? error : new LoginCliError('Authentication failed. Run cortex auth status, then cortex auth login to retry.');
    return { exitCode: safe.exitCode, stdout: JSON.stringify({ ok: false, state: safe.exitCode === 130 ? 'cancelled' : 'failed' }), stderr: safe.message };
  } finally { restoreLog(); }
}
