// input:  normalized channel outcomes and bilingual vocabulary
// output: honest per-channel toast feedback
// pos:    Manual check presentation adapter
// >>> If updated, update this header and parent CORTEX.md <<<

import type { ToastInput } from '@/design/Toast';
import type { Vocab } from '@/i18n/vocab';
import type { ChannelOutcome, UpdateCheckReport } from './manual-update-check';

function reasonText(reason: string | undefined, L: Vocab): string | undefined {
  const reasons: Record<string, string> = {
    unsupported_shell: L.updateCheckUnsupported,
    invalid_report: L.updateCheckInvalid,
    no_credentials: L.updateCheckCredentials,
    'disabled by CORTEX_APP_UPDATE_DISABLE': L.updateCheckDisabled,
    'dev mode (CORTEX_FRONTEND_DIR is set)': L.updateCheckDev,
    dev_version: L.updateCheckDev,
    version_skipped: L.updateCheckSkippedVersion,
    no_matching_asset: L.updateCheckNoAsset,
    update_in_progress: L.updateCheckInProgress,
    restart_or_install_pending: L.updateCheckRestartPending,
    not_scheduled: L.updateCheckNotScheduled,
  };
  if (reason?.startsWith('dev version ')) return L.updateCheckDev;
  return reason ? reasons[reason] : undefined;
}

function channelFeedback(title: string, outcome: ChannelOutcome<unknown>, L: Vocab): ToastInput {
  const descriptions = {
    available: L.updateCheckAvailable, current: L.updateCheckCurrent,
    skipped: L.updateCheckSkipped, error: L.updateCheckError,
  };
  // Unknown native errors can contain URLs/paths. Do not echo them into UI feedback.
  const description = [descriptions[outcome.status], reasonText(outcome.reason, L)];
  if (outcome.update && outcome.status !== 'available') description.push(L.updateCheckCached);
  return {
    title, description: description.filter(Boolean).join(' '), duration: 12_000,
    tone: outcome.status === 'error' ? 'failed' : outcome.status === 'skipped' ? 'waiting' : 'done',
  };
}

export function updateCheckFeedback(report: UpdateCheckReport, L: Vocab): ToastInput[] {
  return [channelFeedback(L.updateCheckUi, report.ui, L), channelFeedback(L.updateCheckShell, report.shell, L)];
}
