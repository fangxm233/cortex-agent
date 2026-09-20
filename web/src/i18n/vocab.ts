// input:  base, feature, platform, update-check and browser-login copy
// output: merged bilingual vocabulary and Vocab type
// pos:    Web vocabulary composition root
// >>> Once updated, update this header and parent AGENTS.md <<<

import { windowActionsEn, windowActionsZh } from './window-actions-vocab';
import { updateCheckEn, updateCheckZh } from './update-check-vocab';
import { platformEn, platformZh } from './platform-settings-vocab';
import { pluginEn, pluginZh } from './plugins-vocab';
import { setupEn, setupZh } from './provider-setup-vocab';
import { uiAuthEn, uiAuthZh } from './ui-auth-vocab';
import { enBase } from './vocab-en-base';
import { enExtra } from './vocab-en-extra';
import { zhBase } from './vocab-zh-base';
import { zhExtra } from './vocab-zh-extra';

export const en = {
  ...enBase,
  ...pluginEn,
  ...enExtra,
  ...setupEn,
  ...platformEn,
  ...updateCheckEn,
  ...uiAuthEn,
  ...windowActionsEn,
};

export type Vocab = typeof en;

export const zh: Record<keyof Vocab, string> = {
  ...zhBase,
  ...pluginZh,
  ...zhExtra,
  ...setupZh,
  ...platformZh,
  ...updateCheckZh,
  ...uiAuthZh,
  ...windowActionsZh,
};
