import { t } from '@core/i18n.js';
import {
  readUsageSharing,
  usageSharingIssues,
  writeUsageSharing,
  type UsageSharingSettings,
} from '@domain/costs/aistatus-config.js';
import type { MutateArgs, Result, UiServiceDeps } from '../types.js';

/**
 * Save the leaderboard opt-in and return what is now stored. Turning it off keeps the stored
 * identity so turning it back on later starts from it. Nothing is restarted: the gateway reloads
 * the file itself.
 */
export async function handleUsageSharingSet(
  deps: UiServiceDeps,
  args: MutateArgs<'usageSharing.set'>,
): Promise<Result<UsageSharingSettings>> {
  const issues = usageSharingIssues(args);
  if (issues.length > 0) {
    const message = issues.map((issue) => t(`usageSharing.issue.${issue}` as Parameters<typeof t>[0])).join(' ');
    return { ok: false, code: 'invalid-args', message };
  }
  writeUsageSharing(args, deps.usageSharingDir);
  return { ok: true, data: readUsageSharing(deps.usageSharingDir) };
}
