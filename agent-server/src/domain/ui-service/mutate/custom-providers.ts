// input:  custom provider drafts and the stores held in UiServiceDeps
// output: upsert and remove results over the PI catalog and gateway route
// pos:    Write handlers for the user-defined PI provider operations
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { t } from '@core/i18n.js';
import {
  defaultCustomProviderStores,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProviderFailure,
  type CustomProviderStores,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';
import type {
  AuthRemoveCustomProviderArgs,
  AuthRemoveCustomProviderReturn,
  AuthUpsertCustomProviderArgs,
  Result,
  UiServiceDeps,
} from '../types.js';

function storesOf(deps: UiServiceDeps): CustomProviderStores {
  return deps.customProviderStores ?? defaultCustomProviderStores();
}

/** One message table serves every surface, so the Web text matches what the CLI prints. */
function issueText(issue: CustomProviderFailure): string {
  return t(`provider.issue.${issue}` as Parameters<typeof t>[0]);
}

/**
 * A missing definition is a client error, a failed write is ours, and anything else is a rejected
 * draft the form can correct.
 */
function failure(errors: CustomProviderFailure[]): Result<never> {
  const code = errors.includes('not-found')
    ? 'not-found'
    : errors.includes('write-failed') ? 'internal' : 'invalid-args';
  return { ok: false, code, message: errors.map(issueText).join(' ') };
}

/**
 * Create or edit a provider. `apiKey` is optional on purpose: leaving it out keeps the stored
 * upstream secret, so an edit form need not ask the operator to retype a key it never displays.
 */
export async function handleCustomProviderUpsert(
  deps: UiServiceDeps,
  args: AuthUpsertCustomProviderArgs,
): Promise<Result<CustomProviderView>> {
  const result = upsertCustomProvider(storesOf(deps), args);
  // `=== true` rather than a truthiness test: this project typechecks with `strict: false`, where
  // truthiness alone does not narrow a boolean-literal discriminant.
  return result.ok === true ? { ok: true, data: result.provider } : failure(result.errors);
}

export async function handleCustomProviderRemove(
  deps: UiServiceDeps,
  args: AuthRemoveCustomProviderArgs,
): Promise<Result<AuthRemoveCustomProviderReturn>> {
  const result = removeCustomProvider(storesOf(deps), args.name);
  return result.ok === true ? { ok: true, data: { removed: true } } : failure(result.errors);
}
