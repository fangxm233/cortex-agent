// input:  @platform/index.js + @orch/interactions/command-action-router.js + @domain/system/update-prompt.js
// output: createUpdatePrompt(adapter, router, opts?) => UpdatePrompt
// pos:    Platform-neutral UpdatePrompt implementation — pre-registers three actionIds on router,
//         posts interactive message to system-notice, resolves ask() promise on button click.

import type { PlatformAdapter, ActionElement, MessageRef, MessageContent } from '@platform/index.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { UpdateChoice, UpdatePrompt } from '@domain/system/update-prompt.js';
import { fetchReleaseNote, buildGitHubReleaseUrl } from '@domain/system/github-release.js';
import { createLogger } from '@core/log.js';
import { t } from '../../core/i18n.js';

const log = createLogger('update-prompt');

// --- Internal state ---

interface PendingState {
  resolve: (value: UpdateChoice | null) => void;
  messageRef: MessageRef;
  latestVersion: string;
}

const DEFAULT_TIMEOUT_MS = 86_400_000; // 24h

// --- Factory ---

export function createUpdatePrompt(
  adapter: PlatformAdapter,
  router: CommandActionRouter,
  opts?: { timeoutMs?: number },
): UpdatePrompt {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let pending: PendingState | null = null;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  // --- Internal helpers ---

  const clearPending = () => {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
      timerHandle = undefined;
    }
    pending = null;
  };

  const resolveText = (choice: UpdateChoice, version: string): string => {
    switch (choice) {
      case 'apply':
        return t('update.installing', { version });
      case 'skip':
        return t('update.skipped', { version });
      case 'cancel':
        return t('update.cancelled');
    }
  };

  /**
   * Format release note info into a message.
   * Truncates if too long (safe for Slack/Feishu 4000 char limit).
   */
  const formatReleaseNoteMessage = (releaseInfo: import('@domain/system/github-release.js').ReleaseInfo): MessageContent => {
    let body = releaseInfo.body || t('update.releaseNotesEmpty');

    // Truncate to safe length (~3500 chars to leave room for header/footer)
    if (body.length > 3500) {
      body = body.substring(0, 3500).trimEnd() + t('update.releaseNotesTruncated');
    }

    return {
      text: t('update.releaseNotesTitle', { version: releaseInfo.version }),
      richBlocks: [
        {
          type: 'section',
          text: t('update.releaseNotesBody', { name: releaseInfo.name, body, url: releaseInfo.htmlUrl }),
        },
      ],
    };
  };

  // --- Build click handlers ---

  const buildHandler = (choice: UpdateChoice) => {
    return async (ctx: import('@platform/index.js').ActionContext): Promise<void> => {
      if (!pending) return; // stale click — no pending prompt

      const p = pending;
      const version = p.latestVersion;
      clearPending();
      p.resolve(choice);

      if (ctx.messageRef) {
        await adapter.updateMessage(ctx.messageRef, { text: resolveText(choice, version) }).catch(() => {});
      }
    };
  };

  const handleReleaseNote = async (ctx: import('@platform/index.js').ActionContext): Promise<void> => {
    if (!pending) return;

    const version = pending.latestVersion;
    log.debug(`Fetching release notes for version ${version}`);

    try {
      const releaseInfo = await fetchReleaseNote(version);

      if (releaseInfo) {
        const message = formatReleaseNoteMessage(releaseInfo);
        await adapter.postMessage({ type: 'system-notice' }, message).catch((e) => {
          log.error(`Failed to post release note message: ${(e as Error).message}`);
        });
      } else {
        // Fallback: send GitHub link
        const url = buildGitHubReleaseUrl(version);
        await adapter
          .postMessage({ type: 'system-notice' }, {
            text: t('update.releaseNotesFetchFailed', { version, url }),
          })
          .catch((e) => {
            log.error(`Failed to post fallback release note: ${(e as Error).message}`);
          });
      }
    } catch (error) {
      log.error(`Error in release note handler: ${(error as Error).message}`);
    }
  };

  // --- Pre-register four actionIds on router ---

  router.registerCommand('update', {
    actions: [
      { actionId: 'apply', handler: buildHandler('apply') },
      { actionId: 'skip', handler: buildHandler('skip') },
      { actionId: 'cancel', handler: buildHandler('cancel') },
      { actionId: 'release-note', handler: handleReleaseNote },
    ],
  });

  // --- Button templates (value filled in at ask time) ---

  const buttonTemplates: ActionElement[] = [
    { type: 'button', text: t('update.button.update'), actionId: 'cmd:update:apply', value: '', style: 'primary' },
    { type: 'button', text: t('update.button.releaseNote'), actionId: 'cmd:update:release-note', value: '' },
    { type: 'button', text: t('update.button.skip'), actionId: 'cmd:update:skip', value: '' },
    { type: 'button', text: t('update.button.cancel'), actionId: 'cmd:update:cancel', value: '', style: 'danger' },
  ];

  // --- Return the UpdatePrompt implementation ---

  return {
    async ask(spec) {
      // Resolve any existing pending prompt
      if (pending) {
        const old = pending;
        clearPending();
        old.resolve(null);
        if (old.messageRef) {
          await adapter.updateMessage(old.messageRef, { text: t('update.superseded') }).catch(() => {});
        }
      }

      // Stamp version onto buttons
      const versionedButtons = buttonTemplates.map(b => ({ ...b, value: spec.latestVersion }));

      // Post interactive message to admin DM.
      // Convention: richBlocks contains content-only sections; buttons go in the
      // top-level `actions` field. The Slack adapter's postInteractive
      // (adapters/slack.ts:434-440) appends an actions block from content.actions,
      // so embedding another actions block inside richBlocks would duplicate the
      // button row. Pattern follows buildPlanApprovalContent
      // (platform/interactive-builder.ts:117-127).
      const messageRef = await adapter.postInteractive(
        { type: 'system-notice' },
        {
          text: t('update.available', { version: spec.latestVersion }),
          richBlocks: [
            { type: 'section', text: t('update.availableSection', { version: spec.latestVersion }) },
          ],
          actions: versionedButtons,
        },
      );

      // Create new pending promise
      return new Promise<UpdateChoice | null>((resolve) => {
        pending = { resolve, messageRef, latestVersion: spec.latestVersion };

        timerHandle = setTimeout(() => {
          if (!pending || pending.resolve !== resolve) return; // already handled
          const ref = pending.messageRef;
          clearPending();
          resolve(null);
          adapter.updateMessage(ref, { text: t('update.timedOut') }).catch(() => {});
        }, timeoutMs).unref();
      });
    },
  };
}
