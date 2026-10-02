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

  return { ask: (spec) => askWithFallback(fallback, spec, fallbackMs) };
}

function askWithFallback(
  fallback: UpdatePrompt, spec: { latestVersion: string }, fallbackMs: number,
): Promise<UpdateChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // First answer wins; late chat answers/errors cannot affect a replacement prompt.
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
      askChat(fallback, spec, finish);
    }, fallbackMs);
    timer.unref?.();
  });
}

function askChat(
  fallback: UpdatePrompt, spec: { latestVersion: string }, finish: (choice: UpdateChoice | null) => void,
): void {
  void fallback.ask(spec).then(finish).catch((e: unknown) => {
    log.error(`Chat-message update prompt failed: ${(e as Error).message}`);
    // Release consent ownership so a later check can retry the chat prompt.
    finish(null);
  });
}
