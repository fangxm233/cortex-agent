// input:  a raw thread-template entity (agent / template / shell) + a raw registry snapshot
// output: validateEntity / validateRegistry / rawRegistryFromDir → { errors, warnings }
// pos:    The validation layer the config never had. The loader is fail-soft (it skips a bad file
//         with a warning) and the executor re-reads templates on EVERY step, so a broken edit does
//         not fail loudly — it makes a running thread stall at `no_matching_transition`. This module
//         is the single place that says what "broken" means, and is consumed by the write path
//         (errors block a save) and by loadConfig (warnings are logged, never enforced).
//         Errors are the confident set: parse failures, name/filename mismatch, missing required
//         fields, broken cross-references, invalid regexes, shell expansion throws. Anything merely
//         unrecognised is a warning, so a schema that has drifted can never lock a user out.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { z } from 'zod';
import { isShellBinding, expandShell } from './shell-templates.js';
import { parseTarget } from './utils.js';
import type { AgentDefinition, ShellDefinition, ShellTemplateBinding } from '@core/types/thread-types.js';

export type EntityKind = 'agent' | 'template' | 'shell';

/** `path` anchors the issue at a field (`transitions[2].from`) so the editor can point at it. */
export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

/** Raw (unexpanded, un-file-ref-resolved) config as it sits on disk: name → parsed JSON. */
export interface RawRegistry {
  agents: Record<string, unknown>;
  templates: Record<string, unknown>;
  shells: Record<string, unknown>;
}

/** Optional filesystem probes. Omitted in unit tests, injected by the API handler. */
export interface RefResolver {
  promptsDir: string;
  pluginBaseDir: string;
  join: (...parts: string[]) => string;
  exists: (absPath: string) => boolean;
  isAbsolute: (p: string) => boolean;
}

/** `__active__` is the runtime-resolved default agent (prompt-builder.ts:20), not a config entity. */
export const ACTIVE_AGENT = '__active__';

const FILE_REF_PREFIX = 'file:';
const PROMPT_FIELD_DIRS: Record<string, string> = {
  directive: 'directives',
  promptTemplate: 'promptTemplates',
  systemPrompt: 'systemPrompts',
};

// --- Structural schemas (mirror core/types/thread-types.ts) ---

// Exported for the compile-time parity guard in template-validate.parity.ts, which pins them
// against the interfaces in core/types/thread-types.ts so the two cannot drift apart silently.
export const stageSchema = z.object({
  promptTemplate: z.string(),
  continuesSession: z.boolean().optional(),
  description: z.string().optional(),
});

export const conditionSchema = z.object({
  type: z.enum(['always', 'convergence', 'output_contains', 'output_not_contains']),
  marker: z.string().optional(),
  pattern: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
});

export const transitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: conditionSchema,
});

export const hookConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().positive().optional(),
});

export const hooksSchema = z.object({
  onStart: hookConfigSchema.optional(),
  onTransition: hookConfigSchema.optional(),
  onEnd: hookConfigSchema.optional(),
});

export const agentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  profile: z.string().min(1),
  persistSession: z.boolean(),
  directive: z.string().optional(),
  systemPrompt: z.string().optional(),
  promptTemplate: z.string().optional(),
  claudeAgent: z.string().optional(),
  outputStyle: z.string().optional(),
  tools: z.string().optional(),
  pluginDirs: z.array(z.string()).optional(),
  mcpComposition: z.enum(['direct', 'thread-control', 'none', 'benchmark-thread-run']).optional(),
  stages: z.record(z.string(), stageSchema).optional(),
  entryStage: z.string().optional(),
});

export const agentRefOverrideSchema = z.object({
  ref: z.string().min(1),
  promptTemplate: z.string().optional(),
  directive: z.string().optional(),
  systemPrompt: z.string().optional(),
  persistSession: z.boolean().optional(),
  claudeAgent: z.string().optional(),
  outputStyle: z.string().optional(),
  tools: z.string().optional(),
  pluginDirs: z.array(z.string()).optional(),
});

export const agentRefSchema = z.union([z.string().min(1), agentRefOverrideSchema]);

export const templateSchema = z.object({
  name: z.string().min(1).optional(), // may be omitted in directory form; checked against filename
  description: z.string(),
  agents: z.array(agentRefSchema).min(1),
  transitions: z.array(transitionSchema),
  entryAgent: z.string().min(1),
  entryStage: z.string().optional(),
  maxTotalSteps: z.number().int().positive(),
  maxTotalCostUsd: z.number().positive().optional(),
  disableHooks: z.boolean().optional(),
  hooks: hooksSchema.optional(),
});

export const shellBindingSchema = z.object({
  shell: z.string().min(1),
  description: z.string().optional(),
  maxTotalSteps: z.number().int().positive().optional(),
});

export const shellSchema = z.object({
  params: z.array(z.string().min(1)),
  agents: z.array(z.string().min(1)),
  transitions: z.array(transitionSchema),
  entryAgent: z.string().min(1),
  entryStage: z.string().optional(),
  maxTotalSteps: z.number().int().positive(),
  maxTotalCostUsd: z.number().positive().optional(),
  hooks: hooksSchema.optional(),
});

// Keys the schemas know about. Anything else is a warning, never an error. Shell bindings are
// excluded on purpose: their parameter values live alongside the reserved keys by design.
const AGENT_KEYS = new Set(Object.keys(agentSchema.shape));
const TEMPLATE_KEYS = new Set(Object.keys(templateSchema.shape));
const SHELL_KEYS = new Set(Object.keys(shellSchema.shape));

// --- Helpers ---

function formatPath(segments: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function zodIssues(result: z.ZodSafeParseResult<unknown>): Issue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: formatPath(issue.path) || '(root)',
    message: issue.message,
  }));
}

function unknownKeyWarnings(body: Record<string, unknown>, known: ReadonlySet<string>): Issue[] {
  return Object.keys(body)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: key, message: `Unrecognised field "${key}" — it will be ignored` }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Registry agents as AgentDefinitions, for the shell expander. Non-object entries are dropped. */
function agentDefs(registry: RawRegistry): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const [name, body] of Object.entries(registry.agents)) {
    if (isPlainObject(body)) out[name] = body as unknown as AgentDefinition;
  }
  return out;
}

function stagesOf(agent: unknown): Record<string, unknown> | null {
  if (!isPlainObject(agent) || !isPlainObject(agent.stages)) return null;
  return agent.stages;
}

/** Every `{token}` in a string, without the braces. */
function placeholderTokens(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function checkRegex(pattern: string, path: string, errors: Issue[]): void {
  try {
    new RegExp(pattern);
  } catch (error) {
    errors.push({
      path,
      message: `Invalid regex: ${error instanceof Error ? error.message : String(error)} — this transition can never fire`,
    });
  }
}

/**
 * Condition sanity. A convergence with no marker degenerates into a plain loop counter and an empty
 * pattern matches everything — both run, so both are warnings; an unparseable regex cannot, so it is
 * an error (`evaluatePatternMatch` catches the throw and the edge is dead — state-machine.ts:456).
 */
function checkCondition(condition: unknown, path: string, result: ValidationResult): void {
  if (!isPlainObject(condition)) return;
  const type = condition.type;
  if (type === 'convergence' && typeof condition.marker !== 'string') {
    result.warnings.push({
      path: `${path}.marker`,
      message: 'convergence without a marker never converges — it only stops at maxIterations',
    });
  }
  if (type === 'output_contains' || type === 'output_not_contains') {
    if (typeof condition.pattern !== 'string' || condition.pattern === '') {
      result.warnings.push({
        path: `${path}.pattern`,
        message: `${String(type)} with an empty pattern matches every output`,
      });
    } else {
      checkRegex(condition.pattern, `${path}.pattern`, result.errors);
    }
  }
}

// --- Agent validation ---

function checkPromptFileRef(
  field: string,
  value: unknown,
  path: string,
  refs: RefResolver | undefined,
  warnings: Issue[],
): void {
  if (!refs || typeof value !== 'string' || !value.startsWith(FILE_REF_PREFIX)) return;
  const subdir = PROMPT_FIELD_DIRS[field];
  if (!subdir) return;
  const filename = value.slice(FILE_REF_PREFIX.length);
  if (!refs.exists(refs.join(refs.promptsDir, subdir, filename))) {
    warnings.push({
      path,
      message: `prompts/${subdir}/${filename} does not exist — the literal string "${value}" will be used as the prompt`,
    });
  }
}

function validateAgent(
  name: string,
  body: Record<string, unknown>,
  refs: RefResolver | undefined,
): ValidationResult {
  const result: ValidationResult = {
    errors: zodIssues(agentSchema.safeParse(body)),
    warnings: unknownKeyWarnings(body, AGENT_KEYS),
  };

  // The map key is the filename basename, and the loader hard-skips a mismatch (template-loader.ts:220).
  if (typeof body.name === 'string' && body.name !== name) {
    result.errors.push({
      path: 'name',
      message: `name "${body.name}" must equal the filename "${name}" — the loader skips the file otherwise`,
    });
  }

  const stages = stagesOf(body);
  if (stages) {
    const stageNames = Object.keys(stages);
    if (stageNames.length === 0) {
      result.warnings.push({ path: 'stages', message: 'stages is empty — the agent has no prompt to run' });
    }
    if (typeof body.entryStage === 'string' && !stageNames.includes(body.entryStage)) {
      result.errors.push({
        path: 'entryStage',
        message: `entryStage "${body.entryStage}" is not one of the declared stages (${stageNames.join(', ')})`,
      });
    }
    if (body.entryStage === undefined && stageNames.length > 1) {
      result.warnings.push({
        path: 'entryStage',
        message: `no entryStage with ${stageNames.length} stages — "${stageNames[0]}" is silently used`,
      });
    }
    if (typeof body.promptTemplate === 'string') {
      result.warnings.push({
        path: 'promptTemplate',
        message: 'promptTemplate is ignored when stages is declared',
      });
    }
    for (const [stageName, stage] of Object.entries(stages)) {
      if (isPlainObject(stage)) {
        checkPromptFileRef('promptTemplate', stage.promptTemplate, `stages.${stageName}.promptTemplate`, refs, result.warnings);
      }
    }
  } else if (body.promptTemplate === undefined) {
    result.warnings.push({
      path: 'promptTemplate',
      message: 'agent declares neither promptTemplate nor stages — it has no prompt to run',
    });
  }

  for (const field of ['directive', 'systemPrompt', 'promptTemplate']) {
    checkPromptFileRef(field, body[field], field, refs, result.warnings);
  }

  if (refs && Array.isArray(body.pluginDirs)) {
    body.pluginDirs.forEach((dir, i) => {
      if (typeof dir !== 'string') return;
      const abs = refs.isAbsolute(dir) ? dir : refs.join(refs.pluginBaseDir, dir);
      if (!refs.exists(abs)) {
        result.warnings.push({ path: `pluginDirs[${i}]`, message: `plugin directory "${dir}" does not exist` });
      }
    });
  }

  return result;
}

// --- Template validation ---

function agentRefName(ref: unknown): string | null {
  if (typeof ref === 'string') return ref;
  if (isPlainObject(ref) && typeof ref.ref === 'string') return ref.ref;
  return null;
}

/**
 * An endpoint is `agent` or `agent:stage`. The agent must be one the template declares — a target
 * outside the slot roster stalls the thread (`resolveTemplateNextStep` finds no slot and returns
 * null, state-machine.ts:270) and a source outside it is an edge that can never match. A pinned
 * stage the agent does not have is the same class of mistake the shell expander already throws on.
 */
function checkEndpoint(
  endpoint: string,
  path: string,
  slots: ReadonlySet<string>,
  registry: RawRegistry,
  errors: Issue[],
): void {
  const { agent, stage } = parseTarget(endpoint);
  if (!slots.has(agent)) {
    errors.push({
      path,
      message: `"${agent}" is not one of this template's agents (${[...slots].join(', ')})`,
    });
    return;
  }
  if (stage === null || agent === ACTIVE_AGENT) return;
  const stages = stagesOf(registry.agents[agent]);
  if (!stages) {
    errors.push({ path, message: `agent "${agent}" declares no stages, so ":${stage}" cannot be selected` });
  } else if (!(stage in stages)) {
    errors.push({
      path,
      message: `agent "${agent}" has no "${stage}" stage (has: ${Object.keys(stages).join(', ')})`,
    });
  }
}

function validateFullTemplate(
  name: string,
  body: Record<string, unknown>,
  registry: RawRegistry,
): ValidationResult {
  const result: ValidationResult = {
    errors: zodIssues(templateSchema.safeParse(body)),
    warnings: unknownKeyWarnings(body, TEMPLATE_KEYS),
  };

  if (typeof body.name === 'string' && body.name !== name) {
    result.errors.push({
      path: 'name',
      message: `name "${body.name}" must equal the filename "${name}" — the loader skips the file otherwise`,
    });
  }

  const refs = Array.isArray(body.agents) ? body.agents : [];
  const slots = new Set<string>();
  refs.forEach((ref, i) => {
    const agentName = agentRefName(ref);
    if (agentName === null) return; // shape error already reported by zod
    slots.add(agentName);
    if (agentName === ACTIVE_AGENT) return;
    if (!(agentName in registry.agents)) {
      result.errors.push({ path: `agents[${i}]`, message: `unknown agent "${agentName}"` });
    }
  });

  if (typeof body.entryAgent === 'string' && !slots.has(body.entryAgent)) {
    result.errors.push({
      path: 'entryAgent',
      message: `entryAgent "${body.entryAgent}" is not in this template's agents list — the thread cannot take its first step`,
    });
  }

  if (typeof body.entryStage === 'string' && typeof body.entryAgent === 'string') {
    const stages = stagesOf(registry.agents[body.entryAgent]);
    if (stages && !(body.entryStage in stages)) {
      result.errors.push({
        path: 'entryStage',
        message: `entryAgent "${body.entryAgent}" has no "${body.entryStage}" stage (has: ${Object.keys(stages).join(', ')})`,
      });
    } else if (!stages && body.entryAgent !== ACTIVE_AGENT) {
      result.warnings.push({
        path: 'entryStage',
        message: `entryAgent "${body.entryAgent}" declares no stages — entryStage is ignored`,
      });
    }
  }

  const reached = new Set<string>();
  if (typeof body.entryAgent === 'string') reached.add(body.entryAgent);
  const transitions = Array.isArray(body.transitions) ? body.transitions : [];
  transitions.forEach((rule, i) => {
    if (!isPlainObject(rule)) return;
    if (typeof rule.from === 'string') checkEndpoint(rule.from, `transitions[${i}].from`, slots, registry, result.errors);
    if (typeof rule.to === 'string') {
      checkEndpoint(rule.to, `transitions[${i}].to`, slots, registry, result.errors);
      reached.add(parseTarget(rule.to).agent);
    }
    checkCondition(rule.condition, `transitions[${i}].condition`, result);
  });

  for (const slot of slots) {
    if (!reached.has(slot)) {
      result.warnings.push({ path: 'agents', message: `agent "${slot}" is never reached by any transition` });
    }
  }

  return result;
}

function validateShellBinding(
  name: string,
  body: ShellTemplateBinding & Record<string, unknown>,
  registry: RawRegistry,
): ValidationResult {
  const result: ValidationResult = {
    errors: zodIssues(shellBindingSchema.safeParse(body)),
    warnings: [],
  };

  const shell = registry.shells[typeof body.shell === 'string' ? body.shell : ''];
  if (!isPlainObject(shell)) {
    result.errors.push({ path: 'shell', message: `unknown shell "${String(body.shell)}"` });
    return result;
  }

  // Dry-run the real expander rather than re-deriving its seven checks (missing param, unknown
  // placeholder, agent not found, missing entryStage, missing stage) and letting them drift.
  try {
    expandShell(name, body, shell as unknown as ShellDefinition, agentDefs(registry));
  } catch (error) {
    result.errors.push({ path: '(root)', message: error instanceof Error ? error.message : String(error) });
  }

  // Missing params are already reported by expandShell; the reverse — a binding key the shell
  // does not declare — is silently ignored at load time, so it is worth a warning.
  if (Array.isArray(shell.params)) {
    const declared = new Set(shell.params.filter((p): p is string => typeof p === 'string'));
    for (const key of Object.keys(body)) {
      if (!declared.has(key) && !['shell', 'description', 'maxTotalSteps'].includes(key)) {
        result.warnings.push({
          path: key,
          message: `"${key}" is not a parameter of shell "${String(body.shell)}" (declares: ${[...declared].join(', ')})`,
        });
      }
    }
  }

  return result;
}

// --- Shell validation ---

function validateShell(body: Record<string, unknown>): ValidationResult {
  const result: ValidationResult = {
    errors: zodIssues(shellSchema.safeParse(body)),
    warnings: unknownKeyWarnings(body, SHELL_KEYS),
  };

  const params = new Set(
    (Array.isArray(body.params) ? body.params : []).filter((p): p is string => typeof p === 'string'),
  );

  const checkTokens = (value: unknown, path: string): void => {
    if (typeof value !== 'string') return;
    for (const token of placeholderTokens(value)) {
      const dot = token.indexOf('.');
      const param = dot < 0 ? token : token.slice(0, dot);
      const prop = dot < 0 ? '' : token.slice(dot + 1);
      if (!params.has(param)) {
        result.errors.push({ path, message: `unknown placeholder "{${token}}" — "${param}" is not in params` });
      } else if (prop !== '' && prop !== 'entryStage') {
        result.errors.push({ path, message: `unknown placeholder property "{${token}}" — only .entryStage is supported` });
      }
    }
  };

  (Array.isArray(body.agents) ? body.agents : []).forEach((a, i) => checkTokens(a, `agents[${i}]`));
  (Array.isArray(body.transitions) ? body.transitions : []).forEach((rule, i) => {
    if (!isPlainObject(rule)) return;
    checkTokens(rule.from, `transitions[${i}].from`);
    checkTokens(rule.to, `transitions[${i}].to`);
    checkCondition(rule.condition, `transitions[${i}].condition`, result);
  });
  checkTokens(body.entryAgent, 'entryAgent');
  checkTokens(body.entryStage, 'entryStage');
  if (isPlainObject(body.hooks)) {
    for (const [phase, hook] of Object.entries(body.hooks)) {
      if (!isPlainObject(hook)) continue;
      checkTokens(hook.command, `hooks.${phase}.command`);
      (Array.isArray(hook.args) ? hook.args : []).forEach((arg, i) => checkTokens(arg, `hooks.${phase}.args[${i}]`));
    }
  }

  // A shell with no binding is inert; one with bindings is only as valid as its expansions, which
  // the impact pass re-checks against every dependent template.
  return result;
}

// --- Impact: what else breaks if this entity is saved ---

/** Names of the templates whose definition mentions this agent or shell. */
export function dependentTemplates(kind: EntityKind, name: string, registry: RawRegistry): string[] {
  if (kind === 'template') return [];
  const out: string[] = [];
  for (const [templateName, body] of Object.entries(registry.templates)) {
    if (!isPlainObject(body)) continue;
    if (kind === 'shell') {
      if (body.shell === name) out.push(templateName);
      continue;
    }
    if (isShellBinding(body)) {
      if (Object.values(body).some((v) => v === name)) out.push(templateName);
      continue;
    }
    const refs = Array.isArray(body.agents) ? body.agents : [];
    if (refs.some((ref) => agentRefName(ref) === name) || body.entryAgent === name) out.push(templateName);
  }
  return out;
}

/**
 * Re-validate every template that depends on this entity, so removing a stage from an agent or
 * editing a shell surfaces the templates it breaks at save time instead of at the next step of a
 * running thread. Reported against the dependent's name, not the edited field.
 */
function impactIssues(kind: EntityKind, name: string, registry: RawRegistry): Issue[] {
  const out: Issue[] = [];
  for (const templateName of dependentTemplates(kind, name, registry)) {
    const body = registry.templates[templateName];
    if (!isPlainObject(body)) continue;
    const { errors } = isShellBinding(body)
      ? validateShellBinding(templateName, body as ShellTemplateBinding & Record<string, unknown>, registry)
      : validateFullTemplate(templateName, body, registry);
    for (const issue of errors) {
      out.push({ path: `template:${templateName}`, message: `${issue.path}: ${issue.message}` });
    }
  }
  return out;
}

// --- Entry points ---

/**
 * Validate one entity against the registry it will live in. The caller is expected to pass a
 * registry with the candidate already swapped in, so cross-entity references resolve against the
 * post-save world rather than the current one.
 */
export function validateEntity(
  kind: EntityKind,
  name: string,
  body: unknown,
  registry: RawRegistry,
  refs?: RefResolver,
): ValidationResult {
  if (!isPlainObject(body)) {
    return { errors: [{ path: '(root)', message: 'Body must be a JSON object' }], warnings: [] };
  }

  let result: ValidationResult;
  if (kind === 'agent') result = validateAgent(name, body, refs);
  else if (kind === 'shell') result = validateShell(body);
  else if (isShellBinding(body)) {
    result = validateShellBinding(name, body as ShellTemplateBinding & Record<string, unknown>, registry);
  } else result = validateFullTemplate(name, body, registry);

  if (kind !== 'template') result.errors.push(...impactIssues(kind, name, registry));
  return result;
}

/** Validate every entity in a registry. Key format: `<kind>:<name>`. */
export function validateRegistry(
  registry: RawRegistry,
  refs?: RefResolver,
): Map<string, ValidationResult> {
  const out = new Map<string, ValidationResult>();
  const kinds: Array<[EntityKind, Record<string, unknown>]> = [
    ['agent', registry.agents],
    ['template', registry.templates],
    ['shell', registry.shells],
  ];
  for (const [kind, entities] of kinds) {
    for (const [name, body] of Object.entries(entities)) {
      // Skip the impact pass here: validating the whole registry already covers every dependent.
      const result = isPlainObject(body)
        ? kind === 'agent'
          ? validateAgent(name, body, refs)
          : kind === 'shell'
            ? validateShell(body)
            : isShellBinding(body)
              ? validateShellBinding(name, body as ShellTemplateBinding & Record<string, unknown>, registry)
              : validateFullTemplate(name, body, registry)
        : { errors: [{ path: '(root)', message: 'Body must be a JSON object' }], warnings: [] };
      out.set(`${kind}:${name}`, result);
    }
  }
  return out;
}

/** The only I/O in this module: read `<dir>/{agents,templates,shells}/*.json` as raw bodies.
 *  An unparseable file lands as `null`, which every validator reports as a root-level error. */
export function rawRegistryFromDir(dir: string, io: {
  readdirSync: (p: string) => string[];
  readFileSync: (p: string, enc: 'utf8') => string;
  existsSync: (p: string) => boolean;
  join: (...parts: string[]) => string;
}): RawRegistry {
  const readKind = (sub: string): Record<string, unknown> => {
    const full = io.join(dir, sub);
    if (!io.existsSync(full)) return {};
    const out: Record<string, unknown> = {};
    for (const file of io.readdirSync(full)) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -'.json'.length);
      try {
        out[name] = JSON.parse(io.readFileSync(io.join(full, file), 'utf8'));
      } catch {
        out[name] = null;
      }
    }
    return out;
  };
  return { agents: readKind('agents'), templates: readKind('templates'), shells: readKind('shells') };
}

/** Copy of a registry with one entity replaced — what a save would produce. */
export function withCandidate(
  registry: RawRegistry,
  kind: EntityKind,
  name: string,
  body: unknown,
): RawRegistry {
  const key = kind === 'agent' ? 'agents' : kind === 'template' ? 'templates' : 'shells';
  return { ...registry, [key]: { ...registry[key], [name]: body } };
}
