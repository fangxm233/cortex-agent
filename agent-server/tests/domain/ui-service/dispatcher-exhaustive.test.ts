import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  queryHandlers, mutateHandlers, type QueryHandlerMap, type MutateHandlerMap,
} from '../../../src/domain/ui-service/ui-service.js';
import { queryInputSchemas, mutateInputSchemas } from '../../../src/domain/ui-service/input-schemas.js';

test('every query scope and mutate op with an input schema has a handler', () => {
  assert.deepEqual(Object.keys(queryHandlers).sort(), Object.keys(queryInputSchemas).sort());
  assert.deepEqual(Object.keys(mutateHandlers).sort(), Object.keys(mutateInputSchemas).sort());
});

// Type-level (checked by `pnpm typecheck`): a dispatcher missing an op does not compile.
const { 'notes.clearCompleted': _droppedOp, ...incompleteMutate } = mutateHandlers;
// @ts-expect-error a mutate dispatcher without 'notes.clearCompleted' is not a MutateHandlerMap
export const _incompleteMutate: MutateHandlerMap = incompleteMutate;

const { 'projects.list': _droppedScope, ...incompleteQuery } = queryHandlers;
// @ts-expect-error a query dispatcher without 'projects.list' is not a QueryHandlerMap
export const _incompleteQuery: QueryHandlerMap = incompleteQuery;
