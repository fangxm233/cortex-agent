// input:  auth status, shared login service, terminal interaction
// output: localized runAuthLoginCli with abortable secret prompts and safe results
// pos:    TTY provider login without a running daemon
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { randomUUID } from 'node:crypto';
import { formatHelp } from '@core/cli-utils.js';
import { t } from '@core/i18n.js';
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
  return formatHelp({ name: 'cortex auth login', description: t('init.auth.help'), usage: 'cortex auth login [--backend pi|claude] [--provider ID] [--auth-type oauth|api_key]', options: [
    { flag: '--backend pi|claude', description: t('init.auth.backendOption') },
    { flag: '--provider ID', description: t('init.auth.providerOption') },
    { flag: '--auth-type oauth|api_key', description: t('init.auth.typeOption') },
    { flag: '--help, -h', description: t('cmd.auth.cli.helpDescription') },
  ], examples: [{ description: t('init.auth.exampleProvider'), command: 'cortex auth login' }, { description: t('init.auth.exampleClaude'), command: 'cortex auth login --backend claude --provider anthropic --auth-type oauth' }], labels: {
    usage: t('cmd.auth.cli.helpUsage'), commands: t('cmd.auth.cli.helpCommands'),
    options: t('cmd.auth.cli.helpOptions'), examples: t('cmd.auth.cli.helpExamples'),
  } });
}
function parseOptions(args: string[]): Options {
  const result: Record<string, string> = {};
  const flags: Record<string, string> = { '--backend': 'backend', '--provider': 'provider', '--auth-type': 'authType' };
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--') || result[key]) throw new LoginCliError(t('init.auth.invalidOptions'));
    result[key] = args[i + 1];
  }
  if (result.backend && !['pi', 'claude'].includes(result.backend)) throw new LoginCliError(t('init.auth.invalidBackend'));
  if (result.authType && !['oauth', 'api_key'].includes(result.authType)) throw new LoginCliError(t('init.auth.invalidType'));
  return result as Options;
}
async function selectInput(options: Options, deps: LoginCliDeps): Promise<StartLoginFlowInput> {
  const backend = options.backend ?? await deps.ui.select(t('init.auth.backend'), [{ value: 'pi', label: t('init.auth.bundled') }, { value: 'claude', label: 'Claude Code' }]) as 'pi' | 'claude';
  const snapshot = await deps.readStatus();
  const accounts = snapshot.accounts.filter(a => a.backend === backend && a.capabilities.length);
  const provider = options.provider ?? await deps.ui.select(t('init.auth.provider'), accounts.map(a => ({ value: a.provider, label: `${a.label} (${t(`cmd.auth.state.${a.state}`)})` })));
  const account = accounts.find(a => a.provider === provider);
  if (!account) throw new LoginCliError(t('init.auth.unavailable'));
  const authType = options.authType ?? await deps.ui.select(t('init.auth.type'), account.capabilities.map(value => ({ value, label: t(`init.auth.${value}`) }))) as StartLoginFlowInput['authType'];
  if (!account.capabilities.includes(authType)) throw new LoginCliError(t('init.auth.unsupported', { values: account.capabilities.join(', ') }));
  if (backend === 'claude' && !await deps.ensureClaude()) throw new LoginCliError(t('init.auth.installDeclined'), 130);
  return { backend, provider, authType, channel: 'cli', sessionId: randomUUID() };
}
async function answerPrompt(state: LoginFlowState, deps: LoginCliDeps, outerSignal: AbortSignal): Promise<LoginFlowState> {
  const prompt = state.pendingPrompt!;
  const signal = AbortSignal.any([
    outerSignal,
    AbortSignal.timeout(Math.max(1, Date.parse(state.expiresAt) - Date.now())),
  ]);
  let value: string;
  try {
    value = prompt.kind === 'select'
      ? await deps.ui.select(prompt.message, (prompt.options ?? []).map(o => ({ value: o.id, label: o.label })), signal)
      : await deps.ui.secret(prompt.message, signal);
    // A prompt may resolve while cancellation is arriving. Never hand off that answer.
    signal.throwIfAborted();
  } catch (error) {
    if (outerSignal.aborted) throw new LoginCliError(t('init.auth.cancelled'), 130);
    if (signal.aborted) throw new LoginCliError(t('init.auth.expired'));
    throw error;
  }
  return deps.service.respond(state.flowId, value);
}
async function driveFlow(initial: LoginFlowState, deps: LoginCliDeps, signal: AbortSignal): Promise<LoginFlowState> {
  let state = initial;
  let notice = '';
  while (!['done', 'failed', 'cancelled'].includes(state.step)) {
    if (signal.aborted) throw new LoginCliError(t('init.auth.cancelled'), 130);
    if (Date.now() >= Date.parse(state.expiresAt)) throw new LoginCliError(t('init.auth.expired'));
    const nextNotice = JSON.stringify(state.notice);
    if (state.notice && notice !== nextNotice) deps.ui.notify(state.notice);
    notice = nextNotice;
    if (state.pendingPrompt) { state = await answerPrompt(state, deps, signal); continue; }
    await new Promise(resolve => setTimeout(resolve, 150));
    const next = deps.service.getState(state.flowId);
    if (!next) throw new LoginCliError(t('init.auth.expired'));
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
  catch (error) {
    // Best effort only: the shared service refuses cancellation after credential handoff.
    // Do not bypass that fence or claim already-persisting credentials were rolled back.
    await deps.service.cancel(initial.flowId).catch(() => {});
    if (controller.signal.aborted) throw new LoginCliError(t('init.auth.cancelled'), 130);
    throw error;
  }
  finally { process.removeListener('SIGINT', interrupt); }
  if (state.step !== 'done') throw new LoginCliError(t(state.step === 'cancelled' ? 'init.auth.cancelled' : 'init.auth.failed'), state.step === 'cancelled' ? 130 : 1);
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
    if (!deps.tty) throw new LoginCliError(t('init.auth.ttyRequired'));
    return await login(options, deps);
  } catch (error) {
    const safe = error instanceof LoginCliError ? error : new LoginCliError(t('init.auth.failed'));
    return { exitCode: safe.exitCode, stdout: JSON.stringify({ ok: false, state: safe.exitCode === 130 ? 'cancelled' : 'failed' }), stderr: safe.message };
  } finally { restoreLog(); }
}
