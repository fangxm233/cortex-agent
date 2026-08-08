// input:  a §8.3 broker action and its untrusted model-facing payload
// output: G5-W5 strict argument validation or BrokerArgumentsError
// pos:    The exact ten model-facing broker argument schemas
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { z } from 'zod';

import type { BenchmarkBrokerCapability } from './capabilities.js';

export const MAX_BROKER_STRING_CODE_POINTS = 2_000;

const boundedString = z.string()
  .max(MAX_BROKER_STRING_CODE_POINTS * 2)
  .refine(
    value => Array.from(value).length <= MAX_BROKER_STRING_CODE_POINTS,
    `String must not exceed ${MAX_BROKER_STRING_CODE_POINTS} Unicode code points`,
  );

const stringArray = z.array(boundedString);
const subtaskSchema = z.object({
  key: boundedString.optional(),
  text: boundedString,
  template: boundedString.optional(),
  why: boundedString.optional(),
  done_when: boundedString.optional(),
  priority: boundedString.optional(),
  plan: boundedString.optional(),
  depends_on: stringArray.optional(),
}).strict();

const BROKER_ARGUMENT_SCHEMAS = {
  'task.read': z.object({ task_id: boundedString.optional() }).strict(),
  'task.create': z.object({
    text: boundedString,
    why: boundedString.optional(),
    done_when: boundedString.optional(),
    template: boundedString.optional(),
    priority: boundedString.optional(),
    plan: boundedString.optional(),
    depends_on: stringArray.optional(),
  }).strict(),
  'task.decompose': z.object({ subtasks: z.array(subtaskSchema).nonempty() }).strict(),
  'task.claim': z.object({ task_id: boundedString }).strict(),
  'task.propose_complete': z.object({ note: boundedString }).strict(),
  'task.propose_block': z.object({ reason: boundedString }).strict(),
  'artifact.write': z.object({ content: boundedString }).strict(),
  'dependency.declare': z.object({
    task_id: boundedString,
    depends_on: stringArray.nonempty(),
  }).strict(),
  'qa.ask': z.object({ question: boundedString }).strict(),
  'qa.answer': z.object({
    question_id: boundedString,
    answer: boundedString,
  }).strict(),
} as const satisfies Record<BenchmarkBrokerCapability, z.ZodTypeAny>;

/** Schema/protocol rejection converted to MCP `isError` by the later registration surface. */
export class BrokerArgumentsError extends Error {
  constructor(readonly action: string, detail: string) {
    super(`${action}: ${detail}`);
    this.name = 'BrokerArgumentsError';
  }
}

export function assertBrokerArguments(
  action: BenchmarkBrokerCapability,
  payload: Readonly<Record<string, unknown>>,
): void {
  const result = BROKER_ARGUMENT_SCHEMAS[action].safeParse(payload);
  if (result.success) return;
  const issue = result.error.issues[0];
  throw new BrokerArgumentsError(action, issue?.message ?? 'invalid broker arguments');
}
