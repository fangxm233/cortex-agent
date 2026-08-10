// input:  a frozen trial policy, its slot, pinned trial paths and the trial cwd
// output: a per-trial adapter, spawn surface and role surface built from the policy alone
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
export interface TrialAdapterSpec {
  policy: ResolvedTrialPolicy;
  slot: AgentSlot;
  /** Retained only because the legacy non-benchmark path already builds from it (S2). */
  config: ResolvedAgentRunConfig;
  paths: PinnedTrialPaths;
  supervisor: { binary: string; graceMs: number; deadlineMs?: number };
  cwd: string;
}

export interface TrialAdapter {
  adapter: AgentAdapter;
  spawnConfig: AgentSpawnConfig;
  roleSurface: RoleToolSurfaceInput;
  backend: Backend;
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
  fs.writeFileSync(
    path.join(agentDir, 'auth.json'),
    `${JSON.stringify({ [provider]: { type: 'api', key: policy.credential.dummy_token_ref } }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** P4/P5: every PI state directory the trial needs, under `spec.paths.root` and nowhere else. */
function piTrialAdapter(spec: TrialAdapterSpec): AgentAdapter {
  const agentDir = path.join(spec.paths.root, 'pi-agent');
  const sessionDir = path.join(spec.paths.root, 'pi-sessions');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  return new PIAdapter(
    // S6.1: no spawner here. The supervisor is injected onto the spawn config after the factory
    // returns, and `assertBenchmarkSpawn` refuses the spawn if it never arrives.
    undefined,
    sessionDir,
    fixedProviderDiscovery(spec.policy.arm.provider ?? null),
    { agentDir, prepareAgentDir: dir => writeTrialAuth(dir, spec.policy) },
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
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await adapter.close(sessionKey);
    },
  };
}
