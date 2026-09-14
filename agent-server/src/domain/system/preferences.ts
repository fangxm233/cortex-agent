// input:  CONFIG_DIR constant, core/i18n normalizeLocale/setLocale, CORTEX_LANG env
// output: loadPreferences / loadLang / langSource / setLang / applyLang for config/preferences.json
// pos:    operator-level display preferences (language, future UI prefs). This file holds the ONE
//         language knob: it drives every server-side t() string AND, via config.get, the Web UI's
//         vocabulary. Set-once + runtime switchable via !lang or the UI appearance toggle.
//         Separate from mode.json (LLM execution state) by design.

import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from '../../core/utils.js';
import { normalizeLocale, setLocale, type Locale } from '../../core/i18n.js';

/** Operator display preferences. Extensible — language today, room for date/number formats etc. */
export interface Preferences {
  lang?: Locale;
}

// Mutable for test isolation — tests redirect this via _testSetPreferencesFile.
let prefsFilePath: string = path.join(CONFIG_DIR, 'preferences.json');

export function loadPreferences(): Preferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFilePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Resolve the persisted UI language, defaulting to 'en'. */
export function loadLang(): Locale {
  return normalizeLocale(loadPreferences().lang);
}

/** Persist the UI language, preserving any other preference keys already on disk. */
export function setLang(loc: Locale): void {
  const normalized = normalizeLocale(loc);
  const current = loadPreferences();
  const next: Preferences = { ...current, lang: normalized };
  fs.mkdirSync(path.dirname(prefsFilePath), { recursive: true });
  fs.writeFileSync(prefsFilePath, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Where the language the process is actually speaking came from.
 *   'env'     — CORTEX_LANG is set; it wins at boot (see entry/app.ts) and will win again after a
 *               restart, so a UI/!lang write is persisted but only lives until the next boot.
 *   'file'    — preferences.json carries an explicit choice.
 *   'default' — neither; `normalizeLocale(undefined)` → 'en'.
 * Surfaced through config.get so the appearance panel can say so instead of silently lying.
 */
export function langSource(env: NodeJS.ProcessEnv = process.env): 'env' | 'file' | 'default' {
  if (env.CORTEX_LANG) return 'env';
  return loadPreferences().lang ? 'file' : 'default';
}

/**
 * The single entry point for changing the language: persist it AND switch the live locale, so the
 * next t() call already renders in the new language (no restart). `!lang` and the UI's appearance
 * toggle both go through here — two call sites writing this by hand is how they drift apart.
 *
 * `publish` is an optional notifier (wired to the event bus at the composition root) that lets open
 * Web UIs re-read config.get and follow a language change made from chat.
 */
export function applyLang(loc: Locale, publish?: (loc: Locale) => void): Locale {
  const normalized = normalizeLocale(loc);
  setLang(normalized);
  setLocale(normalized);
  publish?.(normalized);
  return normalized;
}

/** Test-only: redirect the preferences file to an isolated temp location. */
export function _testSetPreferencesFile(p: string): void {
  prefsFilePath = p;
}
