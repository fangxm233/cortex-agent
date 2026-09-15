// input:  a fallback UpdatePrompt (the chat-message one from ./update-prompt.js) + domain update state
// output: createUiUpdatePrompt(fallback, opts?) => UpdatePrompt
// pos:    Dialog-first UpdatePrompt: ask() publishes `prompting` for the SPA's system.updateStatus
//         query and waits for system.applyUpdate / system.skipUpdate. A fallback timer hands the
//         same question to the chat-message prompt so Slack/Feishu/headless users are not stranded.

import type { UpdateChoice, UpdatePrompt } from '@domain/system/update-prompt.js';
import {
  openServerUpdatePrompt,
  settleServerUpdatePrompt,
} from '@domain/system/update-ui-state.js';
import { createLogger } from '@core/log.js';

const log = createLogger('ui-update-prompt');

/** How long the dialog gets the question to itself before the chat prompt is posted too. */
export const DEFAULT_FALLBACK_MS = 600_000; // 10 min

export interface UiUpdatePromptOptions {
  /** Override the fallback delay (tests use a few milliseconds). */
  fallbackMs?: number;
}

export function createUiUpdatePrompt(
  fallback: UpdatePrompt,
  opts?: UiUpdatePromptOptions,
): UpdatePrompt {
  const fallbackMs = opts?.fallbackMs ?? DEFAULT_FALLBACK_MS;

  return {
    ask(spec) {
      return new Promise<UpdateChoice | null>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        // The one place an answer becomes final, whichever side produced it. The loser's
        // answer arrives later (a chat button click has no cancel API — `createUpdatePrompt`
        // only clears its pending state on click or on its own 24h timeout) and is dropped here.
        const finish = (choice: UpdateChoice | null): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          settleServerUpdatePrompt(choice);
          resolve(choice);
        };

        openServerUpdatePrompt(spec.latestVersion, finish);

        timer = setTimeout(() => {
          if (settled) return;
          // Nobody has the SPA open (or nobody looked). Ask again over chat rather than let the
          // update sit behind a dialog no one will ever see.
          void fallback
            .ask(spec)
            .then(finish)
            .catch((e: unknown) => {
              log.error(`Chat-message update prompt failed: ${(e as Error).message}`);
            });
        }, fallbackMs);
        timer.unref?.();
      });
    },
  };
}
