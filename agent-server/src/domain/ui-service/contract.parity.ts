// Compile-time parity between the wire schemas and the public DTOs. No runtime imports.
import type { z } from 'zod';
import type { EngineSelection, ModelRef } from '@domain/agents/engine-selection.js';
import type { engineSelectionInput, modelRefInput, mutateInputSchemas, queryInputSchemas } from './input-schemas.js';
import type { MutateArgs, MutateReturnMap, QueryReturnMap } from './types.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type EngineSelectionInputParity = Assert<Equal<z.input<typeof engineSelectionInput>, EngineSelection>>;
export type EngineSelectionOutputParity = Assert<Equal<z.output<typeof engineSelectionInput>, EngineSelection>>;
export type ModelRefParity = Assert<Equal<z.output<typeof modelRefInput>, ModelRef>>;
export type SelectionMutationParity = Assert<Equal<MutateArgs<'sessions.setSelection'>, {
  sessionId: string; selection: EngineSelection;
}>>;
export type DefaultMutationParity = Assert<Equal<MutateArgs<'models.setDefault'>, { selection: EngineSelection }>>;
export type QueryParity = Assert<Equal<keyof typeof queryInputSchemas, keyof QueryReturnMap>>;
export type MutationParity = Assert<Equal<keyof typeof mutateInputSchemas, keyof MutateReturnMap>>;
