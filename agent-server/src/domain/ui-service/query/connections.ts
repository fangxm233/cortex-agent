import { createCredentialInventory, type ConnectionView } from '@domain/connections/index.js';
import type { UiServiceDeps, QueryParams } from '../types.js';

/** Every connection this host has, Claude's subscription first. Views carry a key hint, never a key. */
export async function handleConnectionsList(
  deps: UiServiceDeps,
  _params: QueryParams<'connections.list'>,
): Promise<ConnectionView[]> {
  return createCredentialInventory({ file: deps.connectionEditor?.file }).list();
}
