// input:  per-cluster Simplified-Chinese slices (./slices/*) + MessageKey from en.ts
// output: `zh` — aggregated zh table, typed Record<MessageKey, string>
// pos:    L0 locale barrel; the Record<MessageKey,...> type forces parity with en.ts at compile time
// >>> Keep slice keys in lockstep with their en counterparts <<<

import type { MessageKey } from './en.js';
import { langZh } from './slices/lang.js';
import { statusZh } from './slices/status.js';
import { commandsZh } from './slices/commands.js';
import { schedulingZh } from './slices/scheduling.js';
import { interactionsZh } from './slices/interactions.js';
import { startupZh } from './slices/startup.js';
import { initZh } from './slices/init.js';
import { providersZh } from './slices/providers.js';

/** Simplified-Chinese translations, aggregated from per-cluster slices. Must provide every
 *  MessageKey (compiler-enforced via Record<MessageKey,string>) and add none. ${param}
 *  placeholders and `code`/*bold* markdown are preserved verbatim from the en slices. */
export const zh: Record<MessageKey, string> = {
  ...langZh,
  ...statusZh,
  ...commandsZh,
  ...schedulingZh,
  ...interactionsZh,
  ...startupZh,
  ...initZh,
  ...providersZh,
};
