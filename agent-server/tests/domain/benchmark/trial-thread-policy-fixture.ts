// input:  a temp root, a backend label and a CLI artifact path
// output: a compiled coder-review trial policy with one role per thread slot
// pos:    Shared trial-policy fixture for the in-trial thread suites
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import type { Backend } from '../../../src/agent-adapter/types.js';
import {
  loadAgentRunConfigWithPolicy, type ResolvedAgentRunConfig,
} from '../../../src/domain/agent-run/run-config.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

export const FIXTURE_MODEL = 'claude-sonnet';
export const FIXTURE_PROFILE = 'benchmark-profile';
export const FIXTURE_PROXY_BASE_URL = 'http://127.0.0.1:49152';
const CLI_VERSION = 'fixture-cli/9.9.9';

/** One tool label per backend namespace, so a role's allow-list is drawn from the arm's own set. */
const ROLE_TOOLS: Record<Backend, Record<string, string[]>> = {
  claude: {
    parent: ['Read', 'Write'],
    'benchmark-coder': ['Read', 'Write', 'Edit'],
    'benchmark-reviewer': ['Read', 'Grep'],
  },
  pi: {
    parent: ['read', 'write'],
    'benchmark-coder': ['read', 'write', 'edit'],
    'benchmark-reviewer': ['read', 'grep'],
  },
};

export const THREAD_SLOTS = ['benchmark-coder', 'benchmark-reviewer'] as const;

export interface TrialPolicyFixture {
  policy: ResolvedTrialPolicy;
  config: ResolvedAgentRunConfig;
  /** Absolute path of the prompt file each slot's system prompt was compiled from. */
  systemPromptOf(slot: string): string;
}

export function writeFixtureAsset(root: string, name: string, content: string, mode?: number): string {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}

/** The trial profile. Its backend is the arm's backend: the compiler reads model execution from the
 *  profile, so a disagreeing pair would compile an arm whose identity names the other backend. */
export function writeTrialProfile(backend: Backend): void {
  const configDir = path.join(process.env.CORTEX_HOME as string, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: FIXTURE_PROFILE,
    profiles: {
      [FIXTURE_PROFILE]: {
        model: FIXTURE_MODEL, backend, mode: 'api', provider: 'anthropic',
        extraEnv: {}, extraOption: {}, claudeBackend: 'print', thinking: 'high', fallback: [],
      },
    },
  }));
  profileRepo.invalidate();
}

function role(root: string, backend: Backend, slot: string): Record<string, unknown> {
  return {
    system_prompt_path: writeFixtureAsset(root, `${slot}-system.txt`, `You are the ${slot}.\n`),
    directive_path: writeFixtureAsset(root, `${slot}-directive.txt`, `Act as the ${slot}.\n`),
    tools: ROLE_TOOLS[backend][slot],
    plugin_dirs: [],
    mcp_composition: 'none',
    mcp_config_paths: [writeFixtureAsset(root, `${slot}-mcp.json`, '{"mcpServers":{}}\n')],
    disable_hooks: true,
  };
}

export interface TrialPolicyInput {
  root: string;
  backend: Backend;
  /** Absolute path of the CLI artifact the trial pins. */
  cli: string;
  label?: string;
  mutate?: (input: any) => void;
}

export function armResolution(input: TrialPolicyInput): Record<string, unknown> {
  const { root, backend } = input;
  const defaults = path.resolve('defaults/config/thread-templates');
  return {
    schema_version: 'cortex-benchmark-arm-resolution/1',
    arm: {
      schema_version: 'cortex-benchmark-arm/2',
      kind: 'cortex', name: `cortex-${backend}-coder-review`, backend, provider: 'anthropic',
      model: FIXTURE_MODEL, credential_capability: 'claude-api-key',
      orchestration: { mode: 'coder-review', coder_review_variant: 'audit-retry', ask_manager: false },
      limits: {
        max_thread_starts: 1, max_parent_questions: 0, max_task_depth: 0, max_tasks: 0,
        max_provider_requests: 8, max_resident_agent_processes: 3, max_cost_usd: '2.50',
        deadline_seconds: 90,
      },
    },
    arm_path: `/harness/arms/cortex-${backend}-coder-review.yaml`,
    trial_id: 'trial-001',
    root_run_id: `trial-001.cortex-${backend}-coder-review`,
    task: {
      task_id: 'terminal-task', image_ref: 'registry.invalid/task@sha256:fixture',
      image_digest: `sha256:${'a'.repeat(64)}`,
    },
    profile_name: FIXTURE_PROFILE,
    paid_run: false,
    credential_capabilities: [{
      id: 'claude-api-key', state: 'offline-contract-passed',
      key: {
        runner_or_backend: 'claude', provider: 'anthropic', protocol: 'anthropic-messages',
        credential_kind: 'api-key-bearer', proxy_adapter_version: 'cortex-bench-trial-proxy/2',
      },
    }],
    credential: {
      upstream_base_url: 'https://api.anthropic.com',
      route_identity_host: 'api.anthropic.com',
      proxy_base_url: FIXTURE_PROXY_BASE_URL,
      dummy_token_ref: 'trial-token-handle',
    },
    cli_artifact: { path: input.cli, version: CLI_VERSION },
    model_alias_policy: { kind: 'exact' },
    roles: {
      parent: role(root, backend, 'parent'),
      'benchmark-coder': role(root, backend, 'benchmark-coder'),
      'benchmark-reviewer': role(root, backend, 'benchmark-reviewer'),
    },
    thread_templates: {
      'benchmark-coder-review': path.join(defaults, 'templates', 'benchmark-coder-review.json'),
    },
    thread_agents: {
      'benchmark-coder': path.join(defaults, 'agents', 'benchmark-coder.json'),
      'benchmark-reviewer': path.join(defaults, 'agents', 'benchmark-reviewer.json'),
    },
    // Without it every PI arm refuses at construction before a single step runs.
    pi_benchmark_capability_proven: true,
    artifact_inventory_spec: { expected: ['stdout', 'stderr', 'manifest'] },
  };
}

export function compileTrialPolicy(input: TrialPolicyInput): TrialPolicyFixture {
  writeTrialProfile(input.backend);
  const resolution = armResolution(input);
  input.mutate?.(resolution);
  const file = writeFixtureAsset(
    input.root, `${input.label ?? input.backend}-resolution.json`, JSON.stringify(resolution),
  );
  const loaded = loadAgentRunConfigWithPolicy({ runConfigFile: file, agentSlot: 'parent' });
  const roles = resolution.roles as Record<string, { system_prompt_path: string }>;
  return {
    policy: loaded.policy!,
    config: loaded.config,
    systemPromptOf: slot => roles[slot].system_prompt_path,
  };
}
