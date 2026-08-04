// input:  per-cluster English slices (./slices/*)
// output: `en` — aggregated canonical English message table + MessageKey type
// pos:    L0 locale barrel; zh.ts mirrors it. Each cluster lives in its own slice so i18n
//         extraction work stays conflict-free; this file only spreads them together.
// >>> If I am updated, update zh.ts to match, and the parent folder's CORTEX.md <<<

import { langEn } from './slices/lang.js';
import { statusEn } from './slices/status.js';
import { commandsEn } from './slices/commands.js';
import { schedulingEn } from './slices/scheduling.js';
import { interactionsEn } from './slices/interactions.js';
import { startupEn } from './slices/startup.js';
import { initEn } from './slices/init.js';
import { providersEn } from './slices/providers.js';

/** Canonical English message table, aggregated from per-cluster slices. Keys are dot-namespaced
 *  by area (lang/cmd/status/...). Values may contain ${param} placeholders resolved by i18n.t().
 *  Icons (core/icons.ts) are kept in code, NOT in these strings — only human-readable text here.
 *  Scope: user-facing messaging-platform and CLI text only. Log lines are never localized.
 *  A new key goes into BOTH the En and Zh object of the same slice — the Record<MessageKey,string>
 *  type on zh plus tests/core/i18n.test.ts both fail otherwise. */
export const en = {
  ...langEn,
  ...statusEn,
  ...commandsEn,
  ...schedulingEn,
  ...interactionsEn,
  ...startupEn,
  ...initEn,
  ...providersEn,
};

/** The exact keyset every locale must provide. zh.ts is typed against this. */
export type MessageKey = keyof typeof en;
