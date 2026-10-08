import { readUsageSharing, type UsageSharingSettings } from '@domain/costs/aistatus-config.js';
import type { UiServiceDeps, QueryParams } from '../types.js';

/** A missing config file reads as opted out with an empty identity. */
export async function handleUsageSharingGet(
  deps: UiServiceDeps,
  _params: QueryParams<'usageSharing.get'>,
): Promise<UsageSharingSettings> {
  return readUsageSharing(deps.usageSharingDir);
}
