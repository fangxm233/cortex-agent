// input:  the zod schemas in template-validate.ts and the interfaces in core/types/thread-types.ts
// output: compile-time-only parity assertions (no runtime behaviour)
// pos:    Anti-drift boundary for the thread-template validator. The validator's schemas are a
//         second description of a shape the TS interfaces already describe, so they can drift —
//         a field added to AgentDefinition would silently become an "unrecognised field" warning,
//         and a typo in a schema key would silently stop validating that field. These assertions
//         fail the typecheck instead.
//
//         Two checks per shape, because either alone has a blind spot under this tsconfig
//         (`strict: false`): assignability misses a RENAMED optional field (both directions still
//         satisfy each other when every differing key is optional), and key-set equality misses a
//         field whose TYPE changed. Together they catch both. Deliberate divergences are narrowed
//         explicitly below with the reason.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { z } from 'zod';
import type {
  stageSchema,
  agentSchema,
  agentRefSchema,
  agentRefOverrideSchema,
  templateSchema,
  shellSchema,
  shellBindingSchema,
  transitionSchema,
  hookConfigSchema,
  hooksSchema,
} from './template-validate.js';
import type {
  StageDefinition,
  AgentDefinition,
  TemplateAgentRef,
  ThreadTemplate,
  ShellDefinition,
  ShellTemplateBinding,
  TransitionRule,
  ThreadHookConfig,
  ThreadHooks,
} from '@core/types/thread-types.js';

/** Mutual assignability: true only when A and B are structurally equivalent. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Same field types AND the same field names. */
type Parity<Schema extends z.ZodType, Interface> = Exact<z.infer<Schema>, Interface> extends true
  ? Exact<keyof z.infer<Schema>, keyof Interface>
  : false;

// ── Exact ─────────────────────────────────────────────────────────
const _stage: Parity<typeof stageSchema, StageDefinition> = true;
const _transition: Parity<typeof transitionSchema, TransitionRule> = true;
const _hookConfig: Parity<typeof hookConfigSchema, ThreadHookConfig> = true;
const _hooks: Parity<typeof hooksSchema, ThreadHooks> = true;
const _agent: Parity<typeof agentSchema, AgentDefinition> = true;
const _shell: Parity<typeof shellSchema, ShellDefinition> = true;

// ── Deliberate divergences ────────────────────────────────────────

/** `TemplateAgentRef` is a union with a bare string; `keyof` over a union collapses to the keys
 *  common to both members, so the key check is applied to the object member on its own. */
const _agentRef: Exact<z.infer<typeof agentRefSchema>, TemplateAgentRef> = true;
const _agentRefKeys: Exact<
  keyof z.infer<typeof agentRefOverrideSchema>,
  keyof Exclude<TemplateAgentRef, string>
> = true;

/** `ThreadTemplate.name` is required, but in the directory form the filename is the identity and
 *  the field may be omitted (template-loader.ts:233 only checks it when present). The schema makes
 *  it optional; every other field must still match exactly. */
const _template: Parity<typeof templateSchema, Omit<ThreadTemplate, 'name'> & { name?: string }> = true;

/** `ShellTemplateBinding` carries arbitrary parameter values through an index signature, so the
 *  schema describes only the reserved keys and the key check cannot apply. Assert the one
 *  direction that means anything: everything the schema accepts must be a valid binding. */
const _shellBinding: z.infer<typeof shellBindingSchema> extends ShellTemplateBinding ? true : false = true;

// Referenced so the assertions are not dead code to a linter.
export const THREAD_TEMPLATE_SCHEMA_PARITY = [
  _stage,
  _transition,
  _hookConfig,
  _hooks,
  _agent,
  _shell,
  _agentRef,
  _agentRefKeys,
  _template,
  _shellBinding,
] as const;
