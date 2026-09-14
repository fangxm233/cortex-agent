// input:  core/i18n (t/getLocale), domain/system/preferences (applyLang), injected change notifier
// output: createLangHandler — !lang [en|zh] show/switch handler
// pos:    !lang command. Goes through applyLang, which persists to config/preferences.json AND
//         switches the live locale (no restart). Same knob the Web UI's EN·中 toggle writes, so a
//         switch here also changes the SPA's vocabulary. Registered in commands/index.ts.

import { Icons } from '../../../core/icons.js';
import { t, getLocale, type Locale } from '../../../core/i18n.js';
import { applyLang } from '@domain/system/preferences.js';
import type { PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';

/** Human labels for the confirmation text (shown regardless of active locale). */
const LANG_LABELS: Record<Locale, string> = { en: 'English', zh: '中文' };

/**
 * `onLangChanged` is injected rather than taken as a fourth handler argument on purpose: the
 * command table calls every handler as `(channel, adapter, message, threadAnchorId)`, so a fourth
 * parameter here would silently receive an anchor id. Same factory shape as `createCompactHandler`.
 */
export function createLangHandler(onLangChanged?: (loc: Locale) => void) {
  return async function handleLangCmd(
    _channel: string,
    _adapter: PlatformAdapter,
    trimmedMessage: string,
  ): Promise<CommandResult> {
    const arg = (trimmedMessage.split(/\s+/)[1] || '').trim().toLowerCase();

    // No argument → show current language, the available set, and usage.
    if (!arg) {
      const cur = getLocale();
      return {
        text: [
          t('lang.current', { lang: LANG_LABELS[cur] }),
          t('lang.available'),
          t('lang.usage'),
        ].join('\n'),
      };
    }

    if (arg !== 'en' && arg !== 'zh') {
      return { text: `${Icons.error} ${t('lang.unknown', { lang: arg })}` };
    }

    const loc = arg as Locale;
    // Persist + live switch in one call; the notifier lets open Web UIs follow a chat-side switch
    // instead of sitting on a stale toggle until their next config refetch.
    applyLang(loc, onLangChanged);
    return { text: `${Icons.ok} ${t('lang.switched', { lang: LANG_LABELS[loc] })}` };
  };
}
