// Compile-time guard: the environment schema and the `AgentDefinition` interface must describe the
// same document. Two checks, because either alone has a blind spot under this tsconfig
// (`strict: false`): assignability misses a renamed optional field, and key-set equality misses a
// field whose type changed.

import type { z } from 'zod';
import type { environmentSchema } from './schema.js';
import type { AgentDefinition } from '@core/types/environment-types.js';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Parity<Schema extends z.ZodType, Interface> = Exact<z.infer<Schema>, Interface> extends true
  ? Exact<keyof z.infer<Schema>, keyof Interface>
  : false;

const _environment: Parity<typeof environmentSchema, AgentDefinition> = true;

// Referenced so the assertion is not dead code to a linter.
export const ENVIRONMENT_SCHEMA_PARITY = [_environment] as const;
