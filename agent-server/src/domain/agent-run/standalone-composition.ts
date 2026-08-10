// input:  public arm resolution, explicit trial/output roots and supervisor
// output: validated fresh policy, stores, runtime deps and output adapter
// pos:    Standalone container-side agent-run composition root
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RunningExecutions } from '../../core/running-executions.js';
import type {
  AgentDefinition, AgentSlot, AgentSlotConfig, ThreadRecord, ThreadTemplate,
} from '../../core/types/thread-types.js';
import {
  parseArmDefinitionForCompiler, validateArmResolutionShape,
} from '../benchmark/arm-schema.js';
import { createPolicyBackedResolutionDeps } from '../benchmark/policy-backed-runtime-deps.js';
import {
  createTrialAdapter, trialDirective, trialRunOptions, type TrialAdapter,
} from '../benchmark/trial-adapter-factory.js';
import type { RunAgentOptions } from '../agents/spawn-config.js';
import {
  createBenchmarkTrialRunAgent, type TrialThreadAdapterInput,
} from '../benchmark/trial-thread-adapter.js';
import { createTrialTaskRepository } from '../benchmark/trial-task-ports.js';
import type { ArmResolution } from '../benchmark/policy-compiler.js';
import type { ResolvedTrialPolicy } from '../benchmark/resolved-policy.js';
import type { ResolvedProfileConfig } from '../agents/profile-manager.js';
import { readActiveLeaseState } from '../benchmark/workspace-lease.js';
import {
  failClosedRuntimeDeps, type ExecutionLedgerPort, type LocalThreadRuntimeDeps,
} from '../threads/local-runtime-deps.js';
import {
  createBenchmarkOutputAdapter, type BenchmarkOutputAdapter,
} from './benchmark-output-adapter.js';
import type { AgentSlot as JournalAgentSlot } from './journal.js';
import { preparePinnedTrialPaths, type PinnedTrialPaths } from './pinned-node-process.js';
import {
  loadAgentRunConfigWithPolicy, type ResolvedAgentRunConfig,
} from './run-config.js';
import {
  createStandaloneStores, type StandaloneStoreBundle,
} from './standalone-stores.js';

export interface StandaloneCompositionOptions {
  runConfigFile: string;
  agentSlot: JournalAgentSlot;
  profileName: string;
  rootRunId: string;
  cwd: string;
  trajectoryRoot: string;
  trialRoot: string;
  supervisor: { binary: string; graceMs: number; deadlineMs?: number };
  requireFresh: boolean;
}

export interface StandaloneAgentRunComposition {
  policy: ResolvedTrialPolicy;
  config: ResolvedAgentRunConfig;
  profile: ResolvedProfileConfig;
  paths: PinnedTrialPaths;
  stores: StandaloneStoreBundle;
  taskRepository: ReturnType<typeof createTrialTaskRepository>;
  coordinator: LocalThreadRuntimeDeps & { portScope: 'fail-closed' };
  output: BenchmarkOutputAdapter;
  parentTrial: TrialAdapter;
  parentRunOptions: RunAgentOptions;
}

function readResolution(file: string): ArmResolution {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read standalone run config '${file}': ${(error as Error).message}`);
  }
  validateArmResolutionShape(value);
  return value as ArmResolution;
}

export function isStandaloneArmResolution(file: string | undefined): file is string {
  if (!file || file === '-') return false;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema_version?: unknown };
    return value?.schema_version === 'cortex-benchmark-arm-resolution/1';
  } catch {
    return false;
  }
}

function standaloneProfile(resolution: ArmResolution): ResolvedProfileConfig {
  const arm = parseArmDefinitionForCompiler(resolution.arm);
  if (arm.kind !== 'cortex' || arm.backend === undefined) {
    throw new Error('Standalone agent-run requires a Cortex arm with a backend');
  }
  return {
    name: resolution.profile_name,
    model: arm.model,
    backend: arm.backend,
    mode: null,
    provider: arm.provider,
    extraEnv: {},
    extraOption: {},
    claudeBackend: 'print',
    thinking: null,
    fallback: [],
  };
}

function loadPolicy(
  options: StandaloneCompositionOptions,
  profile: ResolvedProfileConfig,
): { policy: ResolvedTrialPolicy; config: ResolvedAgentRunConfig } {
  const loaded = loadAgentRunConfigWithPolicy({
    runConfigFile: options.runConfigFile,
    agentSlot: options.agentSlot,
    resolveProfile: name => {
      if (name === profile.name) return profile;
      throw new Error(`Unknown standalone profile: ${name}`);
    },
  });
  if (!loaded.policy) throw new Error('Standalone run config compiled no benchmark policy');
  return { policy: loaded.policy, config: loaded.config };
}

function assetEntry(policy: ResolvedTrialPolicy, kind: string, name: string) {
  const entry = policy.asset_inventory.find(
    candidate => candidate.kind === kind && candidate.logical_name === name,
  );
  if (!entry) throw new Error(`Missing installed ${kind} asset: ${name}`);
  return entry;
}

function readVerifiedJson<T>(policy: ResolvedTrialPolicy, kind: string, name: string): T {
  const entry = assetEntry(policy, kind, name);
  const bytes = fs.readFileSync(entry.resolved_path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.content_sha256) {
    throw new Error(`Installed ${kind} asset changed after policy compilation: ${name}`);
  }
  return JSON.parse(bytes.toString('utf8')) as T;
}

function resolvedAgent(
  policy: ResolvedTrialPolicy,
  profile: ResolvedProfileConfig,
  slot: string,
): AgentDefinition {
  const source = readVerifiedJson<AgentDefinition>(policy, 'thread_agent', slot);
  if (source.name !== slot) throw new Error(`Installed thread agent name mismatch: ${slot}`);
  const role = policy.roles[slot];
  if (!role) throw new Error(`Compiled policy has no role for installed agent: ${slot}`);
  return {
    ...source,
    profile: profile.name,
    directive: trialDirective(policy, slot as JournalAgentSlot),
    systemPrompt: role.systemPrompt,
    tools: role.tools.join(','),
    pluginDirs: [...role.pluginDirs],
    mcpComposition: role.mcpComposition,
  };
}

function slotConfig(agent: AgentDefinition): AgentSlotConfig {
  const { name, description: _description, ...fields } = agent;
  return { slotId: name, ...fields };
}

function templateAgentSlots(
  template: ThreadTemplate,
  agents: Record<string, AgentDefinition>,
): AgentSlotConfig[] {
  return template.agents.map((reference) => {
    if (typeof reference !== 'string') {
      throw new Error(`Installed benchmark template uses an unsupported override: ${template.name}`);
    }
    const agent = agents[reference];
    if (!agent) throw new Error(`Installed benchmark template agent is missing: ${reference}`);
    return slotConfig(agent);
  });
}

function runtimeSnapshot(
  resolution: ArmResolution,
  policy: ResolvedTrialPolicy,
  profile: ResolvedProfileConfig,
) {
  const templates: Record<string, ThreadTemplate> = {};
  const agents: Record<string, AgentDefinition> = {};
  const templateAgents: Record<string, AgentSlotConfig[]> = {};
  for (const name of policy.child_template_whitelist) {
    const template = readVerifiedJson<ThreadTemplate>(policy, 'thread_template', name);
    if (template.name !== name || resolution.thread_templates[name] === undefined) {
      throw new Error(`Installed thread template name mismatch: ${name}`);
    }
    templates[name] = template;
    for (const reference of template.agents) {
      if (typeof reference !== 'string') throw new Error(`Invalid benchmark agent ref: ${name}`);
      agents[reference] ??= resolvedAgent(policy, profile, reference);
    }
    templateAgents[name] = templateAgentSlots(template, agents);
  }
  return { profileName: profile.name, profile, agents, templates, templateAgents };
}

function newAgentSlot(config: AgentSlotConfig): AgentSlot {
  return {
    slotId: config.slotId,
    profile: config.profile,
    sessionId: null,
    sessionName: null,
    status: 'idle',
    lastOutput: null,
    persistSession: config.persistSession,
  };
}

function threadWorkspace(paths: PinnedTrialPaths, id: string) {
  const workspacePath = path.join(paths.root, 'workspaces', 'threads', id);
  const artifactPath = path.join(workspacePath, 'artifact.md');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(artifactPath, '', { flag: 'wx' });
  return { workspacePath, artifactPath };
}

function initialThreadRecord(
  id: string,
  channel: string,
  options: Parameters<LocalThreadRuntimeDeps['createThread']>[1],
  template: ThreadTemplate,
  slots: AgentSlotConfig[],
  paths: PinnedTrialPaths,
): ThreadRecord {
  const now = new Date().toISOString();
  const workspace = threadWorkspace(paths, id);
  const agents = Object.fromEntries(slots.map(slot => [slot.slotId, newAgentSlot(slot)]));
  const metadata = { ...(options.metadata ?? {}), stepStartArtifactHash: createHash('sha256').update('').digest('hex') };
  return {
    id, channel, projectId: options.projectId ?? 'benchmark',
    templateName: template.name, platformThreadId: options.platformThreadId ?? null,
    userMessage: options.userMessage, userMessageTs: options.userMessageTs,
    ...workspace, agents, activeAgent: template.entryAgent,
    activeStage: template.entryStage ?? null, metadata,
    status: 'running', currentStepIndex: 0, steps: [], iterationCounts: {}, totalCostUsd: 0,
    createdAt: now, updatedAt: now, endedAt: null, error: null, abortReason: null,
  };
}

function createThreadFactory(
  stores: StandaloneStoreBundle,
  paths: PinnedTrialPaths,
  resolution: ReturnType<typeof createPolicyBackedResolutionDeps>,
): LocalThreadRuntimeDeps['createThread'] {
  return (channel, options) => {
    if (!options.templateName || options.agentName) {
      throw new Error('Standalone benchmark threads require one installed template');
    }
    const template = resolution.getTemplate(options.templateName);
    const slots = resolution.resolveTemplateAgents(template);
    const id = `thr_${randomBytes(4).toString('hex')}`;
    const record = initialThreadRecord(id, channel, options, template, slots, paths);
    void stores.threads.set(record);
    return record;
  };
}

function executionLedger(
  stores: StandaloneStoreBundle,
  liveExecutions: RunningExecutions,
): ExecutionLedgerPort {
  return {
    startLocalExecution: input => stores.executions.startLocalExecution(input),
    teardownExecution(input) {
      const { executionId, status, result, error, durationS } = input;
      if (!executionId) return null;
      const metrics = { durationS, costUsd: result?.total_cost_usd,
        numTurns: result?.num_turns, finalOutput: result?.finalOutput, error: error?.message };
      if (status === 'completed') {
        liveExecutions.complete(executionId, result?.total_cost_usd ?? 0);
        return stores.executions.completeExecution(executionId, metrics);
      }
      if (status === 'cancelled') {
        liveExecutions.supersede(executionId, 'cancelled');
        return stores.executions.cancelExecution(executionId, metrics);
      }
      liveExecutions.fail(executionId, error?.message ?? 'error');
      return stores.executions.failExecution(executionId, metrics);
    },
    releaseExecutionLocks: () => {},
  };
}

function cancelThread(stores: StandaloneStoreBundle): LocalThreadRuntimeDeps['cancelThread'] {
  return async (threadId) => {
    const thread = stores.threads.get(threadId);
    if (!thread || ['completed', 'failed', 'cancelled', 'aborted'].includes(thread.status)) {
      return false;
    }
    await stores.threads.mutate(threadId, record => {
      record.status = 'cancelled';
      record.endedAt = new Date().toISOString();
    });
    return true;
  };
}

interface CoordinatorInputs {
  policy: ResolvedTrialPolicy;
  source: ArmResolution;
  profile: ResolvedProfileConfig;
  paths: PinnedTrialPaths;
  stores: StandaloneStoreBundle;
  config: ResolvedAgentRunConfig;
  supervisor: StandaloneCompositionOptions['supervisor'];
}

const runStandaloneThread: LocalThreadRuntimeDeps['runThread'] = async (...args) => {
  const runtime = await import('../threads/runner.js');
  return runtime.runThread(...args);
};

function coordinatorDeps(
  input: CoordinatorInputs,
): LocalThreadRuntimeDeps & { portScope: 'fail-closed' } {
  const { policy, source, profile, paths, stores, config, supervisor } = input;
  const resolution = createPolicyBackedResolutionDeps(
    policy, runtimeSnapshot(source, policy, profile),
  );
  const liveExecutions = new RunningExecutions();
  const adapterInput: TrialThreadAdapterInput = {
    policy, config, paths, supervisor, leaseState: readActiveLeaseState,
  };
  return failClosedRuntimeDeps({
    runAgent: createBenchmarkTrialRunAgent(adapterInput),
    executionLedger: executionLedger(stores, liveExecutions),
    executionStore: stores.executions,
    sessionStore: stores.sessions,
    threadStore: stores.threads,
    liveExecutions,
    ...resolution,
    emitLifecycleHooks: async () => {},
    eventBus: null,
    createThread: createThreadFactory(stores, paths, resolution),
    runThread: runStandaloneThread,
    cancelThread: cancelThread(stores),
  });
}

function standaloneInputs(options: StandaloneCompositionOptions) {
  const source = readResolution(options.runConfigFile);
  if (source.root_run_id !== options.rootRunId) {
    throw new Error(
      `Benchmark root_run_id mismatch: expected '${options.rootRunId}', `
      + `received '${source.root_run_id}'`,
    );
  }
  const profile = standaloneProfile(source);
  if (profile.name !== options.profileName) {
    throw new Error(
      `Benchmark profile_name mismatch: expected '${options.profileName}', received '${profile.name}'`,
    );
  }
  return { source, profile };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function projectedPhysicalPath(target: string): string {
  const suffix: string[] = [];
  let existing = path.resolve(target);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...suffix);
}

function assertPhysicalRootProjection(options: StandaloneCompositionOptions): void {
  const trajectoryRoot = path.resolve(options.trajectoryRoot);
  const trialRoot = path.resolve(options.trialRoot);
  const sharedRoot = path.dirname(trajectoryRoot);
  const projections = [sharedRoot, trajectoryRoot, trialRoot];
  if (path.dirname(trialRoot) !== sharedRoot
      || projections.some(candidate => projectedPhysicalPath(candidate) !== candidate)) {
    throw new Error('Standalone state and output roots must share the physical trial root');
  }
}

function unexpectedFreshEntry(root: string, current = root): string | null {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const relative = path.relative(root, target);
    if (entry.isSymbolicLink()) return relative;
    if (entry.isDirectory()) {
      const nested = unexpectedFreshEntry(root, target);
      if (nested) return nested;
    } else {
      return relative;
    }
  }
  return null;
}

function assertFreshTrialRoot(root: string): void {
  if (!fs.existsSync(root)) return;
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Standalone trial root must be fresh: ${root}`);
  }
  const unexpected = unexpectedFreshEntry(root);
  if (unexpected) throw new Error(`Standalone trial root must be fresh: ${unexpected}`);
}

function assertPhysicalRoots(
  options: StandaloneCompositionOptions,
  paths: PinnedTrialPaths,
  output: BenchmarkOutputAdapter,
): void {
  const containerRoot = fs.realpathSync(path.dirname(path.resolve(options.trajectoryRoot)));
  if (!isWithin(containerRoot, paths.root) || !isWithin(containerRoot, output.root)) {
    throw new Error('Standalone state and output roots must share the physical trial root');
  }
  for (const candidate of Object.values(paths).slice(1)) {
    if (!isWithin(paths.root, fs.realpathSync(candidate))) {
      throw new Error(`Pinned trial path escapes the physical trial root: ${candidate}`);
    }
  }
}

function profileIdentityMatches(file: string, profile: ResolvedProfileConfig): boolean {
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      profiles?: Record<string, Record<string, unknown>>;
    };
    const selected = document.profiles?.[profile.name];
    return selected?.model === profile.model && selected.backend === profile.backend
      && selected.provider === profile.provider;
  } catch {
    return false;
  }
}

function replaceProfileProjection(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function materializeProfile(paths: PinnedTrialPaths, profile: ResolvedProfileConfig): void {
  const file = path.join(paths.cortexHome, 'config', 'profiles.json');
  const entry = {
    model: profile.model, backend: profile.backend, provider: profile.provider,
    extraEnv: {}, extraOption: {}, claudeBackend: 'print', fallback: [],
  };
  const document = { defaultProfile: profile.name, profiles: { [profile.name]: entry } };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  else if (fs.readFileSync(file, 'utf8') !== content) {
    if (!profileIdentityMatches(file, profile)) {
      throw new Error(`Standalone profile projection differs from frozen policy: ${file}`);
    }
    replaceProfileProjection(file, content);
  }
}

export function createStandaloneAgentRunComposition(
  options: StandaloneCompositionOptions,
): StandaloneAgentRunComposition {
  const { source, profile } = standaloneInputs(options);
  const loaded = loadPolicy(options, profile);
  if (options.requireFresh) assertFreshTrialRoot(options.trialRoot);
  assertPhysicalRootProjection(options);
  const paths = preparePinnedTrialPaths(options.trialRoot);
  const output = createBenchmarkOutputAdapter(options.trajectoryRoot);
  assertPhysicalRoots(options, paths, output);
  materializeProfile(paths, profile);
  const stores = createStandaloneStores(path.join(paths.cortexHome, 'state'), options.requireFresh);
  const coordinator = coordinatorDeps({
    ...loaded, source, profile, paths, stores, supervisor: options.supervisor,
  });
  const parentSpec = {
    policy: loaded.policy, slot: options.agentSlot, config: loaded.config,
    paths, supervisor: options.supervisor, cwd: options.cwd,
  };
  const parentTrial = createTrialAdapter(parentSpec);
  return {
    ...loaded, profile, paths, stores, coordinator, output, parentTrial,
    taskRepository: createTrialTaskRepository(stores.tasks),
    parentRunOptions: trialRunOptions(parentSpec),
  };
}
