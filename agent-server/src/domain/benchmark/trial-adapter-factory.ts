// input:  frozen trial policy, pinned roots and process admission
// output: credential-pinned adapter, spawn and role surfaces
// pos:    Backend-neutral per-trial adapter construction seam
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../../agent-adapter/claude/adapter.js';
import { PIAdapter } from '../../agent-adapter/pi/adapter.js';
import type { PIProviderDiscovery } from '../../agent-adapter/pi/discovery.js';
import type { AgentAdapter, AgentSpawnConfig, Backend } from '../../agent-adapter/types.js';
import type { IdentityJsonValue, RoleToolSurfaceInput } from '../agent-run/identity.js';
import type { AgentSlot } from '../agent-run/journal.js';
import { pinnedTrialEnvironment, type PinnedTrialPaths } from '../agent-run/pinned-node-process.js';
import { roleSurfaceFromSpawnConfig } from '../agent-run/role-surface.js';
import type { ResolvedAgentRunConfig, ResolvedAgentRunRole } from '../agent-run/run-config.js';
import {
  buildAgentSpawnConfig, type AgentConfig, type RunAgentOptions,
} from '../agents/spawn-config.js';
import { PolicyCompilationError, type ResolvedTrialPolicy } from './resolved-policy.js';

/** S1: the closed input list. It carries no spawner — S6.1 makes `spawnConfig.processSpawner` the
 *  single supervisor injection point, applied by the caller after construction. */
export interface TrialProcessAdmissionInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface TrialAdapterSpec {
  policy: ResolvedTrialPolicy;
  slot: AgentSlot;
  /** Retained only because the legacy non-benchmark path already builds from it (S2). */
  config: ResolvedAgentRunConfig;
  paths: PinnedTrialPaths;
  supervisor: { binary: string; graceMs: number; deadlineMs?: number };
  cwd: string;
  admission?: (input: TrialProcessAdmissionInput) => void;
}

export interface TrialAdapter {
  adapter: AgentAdapter;
  spawnConfig: AgentSpawnConfig;
  roleSurface: RoleToolSurfaceInput;
  backend: Backend;
  admit(input: TrialProcessAdmissionInput): void;
  close(): Promise<void>;
}

/** P8/A7: the trial's provider catalog is the arm's one provider, fixed. `refresh()` is a no-op —
 *  a rescan is both a host reach (A8) and a cross-trial cache leak. */
function fixedProviderDiscovery(provider: string | null): PIProviderDiscovery {
  const providers = provider === null ? [] : [provider];
  return { getProviders: () => [...providers], refresh: () => {} };
}

/**
 * P6/A5/A6: the trial's PI credential is the policy's dummy token, written as a real file into the
 * trial-local agent dir. The shipped daemon path symlinks the host's `~/.pi/agent/auth.json` here,
 * which would make a "trial-local" directory a window onto the host — §3.3's invariant is that a
 * real credential never enters a trial.
 */
function writeTrialAuth(agentDir: string, policy: ResolvedTrialPolicy): void {
  const provider = policy.arm.provider;
  if (provider === null || provider === undefined) return;
  fs.mkdirSync(agentDir, { recursive: true });
  const authPath = path.join(agentDir, 'auth.json');
  if (fs.existsSync(authPath)) {
    const stat = fs.lstatSync(authPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`PI trial auth projection is not a regular file: ${authPath}`);
    }
  }
  const temporary = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify({
    [provider]: { type: 'api', key: policy.credential.dummy_token_ref },
  }, null, 2)}\n`;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, authPath); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** P4/P5: every PI state directory the trial needs, under `spec.paths.root` and nowhere else. */
function piTrialAdapter(spec: TrialAdapterSpec): AgentAdapter {
  const agentDir = path.join(spec.paths.root, 'pi-agent');
  const sessionDir = path.join(spec.paths.root, 'pi-sessions');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  assertPhysicalDirectory(spec.paths.root, agentDir);
  assertPhysicalDirectory(spec.paths.root, sessionDir);
  return new PIAdapter(
    // S6.1: no spawner here. The supervisor is injected onto the spawn config after the factory
    // returns, and `assertBenchmarkSpawn` refuses the spawn if it never arrives.
    undefined,
    sessionDir,
    fixedProviderDiscovery(spec.policy.arm.provider ?? null),
    { agentDir, prepareAgentDir: (dir) => {
      assertPhysicalDirectory(spec.paths.root, dir);
      writeTrialAuth(dir, spec.policy);
    } },
  );
}

/** S8: backend dispatch is a closed table, so an unlisted backend refuses rather than falling back. */
const ADAPTER_CONSTRUCTORS: Partial<Record<Backend, (spec: TrialAdapterSpec) => AgentAdapter>> = {
  claude: () => new ClaudeAdapter(),
  pi: piTrialAdapter,
};

export function trialSessionKey(policy: ResolvedTrialPolicy): string {
  return `agent-run:${policy.root_run_id}`;
}

function refuse(detail: string): never {
  throw new PolicyCompilationError('backend_unsupported_for_kind', detail);
}

const CREDENTIAL_ENV = /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|APP_SECRET|SECRET_ACCESS_KEY|CREDENTIALS)$/;
const AMBIENT_CAPABILITY_ENV = new Set([
  'AWS_PROFILE', 'AZURE_CLIENT_SECRET', 'CORTEX_DAEMON_URL', 'CORTEX_REMOTE_TOKEN',
  'CORTEX_SERVER_URL', 'DOCKER_HOST', 'FEISHU_APP_SECRET', 'GPG_AGENT_INFO',
  'KUBECONFIG', 'NPM_TOKEN', 'SLACK_BOT_TOKEN', 'SSH_AUTH_SOCK',
]);
const PINNED_PATH_MEMBERS: Array<keyof PinnedTrialPaths> = [
  'home', 'cortexHome', 'projectsDir', 'xdgConfigHome', 'xdgCacheHome',
  'claudeConfigDir', 'tempDir', 'logsDir',
];

function assertPhysicalDirectory(root: string, directory: string): void {
  let physical: string;
  try { physical = fs.realpathSync(directory); }
  catch { throw new Error(`Trial directory is unavailable before admission: ${directory}`); }
  const relative = path.relative(root, physical);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Trial directory escaped before admission: ${directory}`);
  }
}

function assertPinnedEnvironment(spec: TrialAdapterSpec, env: NodeJS.ProcessEnv): void {
  for (const member of PINNED_PATH_MEMBERS) {
    const key = ({
      home: 'HOME', cortexHome: 'CORTEX_HOME', projectsDir: 'CORTEX_PROJECTS_DIR',
      xdgConfigHome: 'XDG_CONFIG_HOME', xdgCacheHome: 'XDG_CACHE_HOME',
      claudeConfigDir: 'CLAUDE_CONFIG_DIR', tempDir: 'TMPDIR', logsDir: null,
    } as const)[member];
    assertPhysicalDirectory(spec.paths.root, spec.paths[member]);
    if (key && env[key] !== spec.paths[member]) {
      throw new Error(`Trial process changed pinned ${key} before admission`);
    }
  }
  if (env.TMP !== spec.paths.tempDir || env.TEMP !== spec.paths.tempDir) {
    throw new Error('Trial process changed pinned temporary roots before admission');
  }
}

function assertNoCredentialFallback(env: NodeJS.ProcessEnv, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const forbidden = Object.keys(env).filter(key => (
    CREDENTIAL_ENV.test(key) || AMBIENT_CAPABILITY_ENV.has(key)
  ) && !allowedKeys.has(key));
  if (forbidden.length > 0) {
    throw new Error(`Trial process contains forbidden credential environment: ${forbidden.sort().join(',')}`);
  }
}

function readJson(file: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Trial credential projection is not a regular file: ${file}`);
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Trial credential projection is not an object: ${file}`);
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function assertPiProjection(spec: TrialAdapterSpec, env: NodeJS.ProcessEnv): void {
  const provider = spec.policy.arm.provider;
  const agentDir = path.join(spec.paths.root, 'pi-agent');
  if (!provider || env.PI_CODING_AGENT_DIR !== agentDir) {
    throw new Error('PI trial agent directory or provider is missing before admission');
  }
  assertPhysicalDirectory(spec.paths.root, agentDir);
  assertPhysicalDirectory(spec.paths.root, path.join(spec.paths.root, 'pi-sessions'));
  const auth = readJson(path.join(agentDir, 'auth.json'));
  const models = readJson(path.join(agentDir, 'models.json'));
  const providers = objectValue(models.providers);
  const selected = objectValue(providers[provider]);
  if (JSON.stringify(auth) !== JSON.stringify({
    [provider]: { type: 'api', key: spec.policy.credential.dummy_token_ref },
  })) throw new Error('PI trial auth differs from the fixed dummy credential');
  const selectedKeys = Object.keys(selected);
  const allowedSelected = selectedKeys.every(key => key === 'baseUrl' || key === 'compat');
  if (selected.baseUrl !== spec.policy.credential.proxy_base_url
      || Object.keys(providers).length !== 1 || Object.keys(models).length !== 1
      || !allowedSelected) {
    throw new Error('PI trial provider catalog differs from the scoped proxy');
  }
}

function assertCredentialProjection(
  spec: TrialAdapterSpec, backend: Backend, env: NodeJS.ProcessEnv,
): void {
  if (backend === 'claude') {
    assertNoCredentialFallback(env, ['ANTHROPIC_AUTH_TOKEN']);
    if (env.ANTHROPIC_AUTH_TOKEN !== spec.policy.credential.dummy_token_ref
        || env.ANTHROPIC_BASE_URL !== spec.policy.credential.proxy_base_url) {
      throw new Error('Claude trial credential differs from the fixed dummy/scoped proxy');
    }
    return;
  }
  assertNoCredentialFallback(env, []);
  assertPiProjection(spec, env);
}

function trialBackend(policy: ResolvedTrialPolicy): Backend {
  const backend = policy.arm.backend;
  if (!backend) refuse(`arm '${policy.arm.name}' declares no backend`);
  if (backend === 'pi' && policy.pi_benchmark_capability_proven !== true) {
    refuse('PI benchmark capability is unproven');
  }
  if (ADAPTER_CONSTRUCTORS[backend] === undefined) {
    refuse(`no trial adapter constructor for backend '${backend}'`);
  }
  return backend;
}

// GT2: a slot the compiler admitted always has a key, so an absent guard on the benchmark path is a
// defect. It fails closed here rather than spawning a model process with the ambient hook surface.
function trialGuard(policy: ResolvedTrialPolicy, slot: AgentSlot): IdentityJsonValue {
  const guard = policy.role_policy_guard[slot];
  if (guard === undefined) throw new PolicyCompilationError('policy_guard_absent', `role://${slot}`);
  return guard;
}

function trialRole(policy: ResolvedTrialPolicy, slot: AgentSlot): ResolvedAgentRunRole {
  const role = policy.roles[slot];
  if (role === undefined) throw new PolicyCompilationError('asset_missing', `role://${slot}`);
  return role;
}

function inventoryPath(policy: ResolvedTrialPolicy, kind: string, logicalName?: string): string {
  const entry = policy.asset_inventory.find(asset => (
    asset.kind === kind && (logicalName === undefined || asset.logical_name === logicalName)
  ));
  if (entry === undefined) {
    throw new PolicyCompilationError('asset_missing', `${kind}:${logicalName ?? ''}`);
  }
  return entry.resolved_path;
}

/** The directive bytes the role was compiled from, located through the inventory the compiler
 *  wrote: `ResolvedAgentRunRole` carries no directive and GT3 forbids widening it. A directive
 *  that no longer matches its compiled bytes moves the role hash, which R4 then refuses. */
export function trialDirective(policy: ResolvedTrialPolicy, slot: AgentSlot): string {
  return fs.readFileSync(inventoryPath(policy, 'prompt', `${slot}:directive`), 'utf8');
}

/** C4: role composition is sourced from the policy, never from the disposable projection. */
export function trialRunOptions(spec: TrialAdapterSpec): RunAgentOptions {
  const role = trialRole(spec.policy, spec.slot);
  const key = trialSessionKey(spec.policy);
  return {
    sessionKey: key,
    channel: key,
    profileName: null,
    cwd: spec.cwd,
    awaitBackground: true,
    backgroundWaitPolicy: 'completion-only',
    mcpComposition: role.mcpComposition,
    mcpConfigPaths: role.mcpConfigPaths,
    disableHooks: role.disableHooks,
    streamDeltas: false,
    captureTranscriptLogs: false,
    loadCortexRules: false,
    recordCost: false,
    systemPrompt: role.systemPrompt,
    pluginDirs: role.pluginDirs,
    tools: role.tools.join(','),
    // C2 — one resolved CLI path for both spawn branches.
    cliPath: inventoryPath(spec.policy, 'cli_artifact'),
    // GT4 — the compiled guard travels on the spawn config, never through the projection.
    benchmarkPolicyGuard: trialGuard(spec.policy, spec.slot),
    // C5/C7 and A13 — the child environment is pinned and factory-pure; no ambient parent values enter.
    pinnedEnv: pinnedTrialEnvironment(spec.paths, {}),
    // §5.6 P5 — the instant, not a duration: the child derives its remaining budget when it calls.
    benchmarkDeadlineEpochMs: spec.policy.deadline.absolute_epoch_ms,
  };
}

// C6 with §1.7: the child is routed at the per-trial proxy authority, while the identity host stays
// `model_execution.configured_route_base_host` — the proxy authority feeds no identity hash. No
// member is taken from the host profile, so the profile's own ANTHROPIC_BASE_URL cannot reach here.
export function trialAgentConfig(policy: ResolvedTrialPolicy, backend: Backend): AgentConfig {
  return {
    model: policy.model_execution.requested_model,
    backend,
    mode: null,
    provider: policy.model_execution.provider_protocol,
    // Gate 2 runs one supervised print-mode turn; TUI has no trial surface.
    claudeBackend: 'print',
    thinking: policy.model_execution.reasoning_effort,
    extraEnv: backend === 'claude'
      ? { ANTHROPIC_AUTH_TOKEN: policy.credential.dummy_token_ref }
      : undefined,
  };
}

export function createTrialAdapter(spec: TrialAdapterSpec): TrialAdapter {
  const backend = trialBackend(spec.policy);
  const runOptions = trialRunOptions(spec);
  const directive = trialDirective(spec.policy, spec.slot);
  const adapter = ADAPTER_CONSTRUCTORS[backend]!(spec);
  const spawnConfig = buildAgentSpawnConfig(
    runOptions,
    trialAgentConfig(spec.policy, backend),
    spec.policy.credential.proxy_base_url,
  );
  // P12: the trial is routed at the policy proxy authority with no sub-path, never at the host gateway.
  if (backend === 'pi') {
    spawnConfig.piGatewayPath = '';
    spawnConfig.piGatewayBaseUrl = spec.policy.credential.proxy_base_url;
  }
  spawnConfig.preserveUnreportedAccounting = true;
  const sessionKey = spawnConfig.sessionKey;
  let closed = false;
  return {
    adapter,
    spawnConfig,
    // S7 — all three arguments, so the directive and the guard reach the role hash.
    roleSurface: roleSurfaceFromSpawnConfig(
      spawnConfig, directive, spawnConfig.benchmarkPolicyGuard,
    ),
    backend,
    admit: (input): void => {
      assertPinnedEnvironment(spec, input.env);
      assertCredentialProjection(spec, backend, input.env);
      spec.admission?.(input);
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await adapter.close(sessionKey);
    },
  };
}
