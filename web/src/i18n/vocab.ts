// input:  base, feature, platform and update-check copy
// output: merged bilingual vocabulary and Vocab type
// pos:    Web vocabulary composition root
// >>> Once updated, update this header and parent CORTEX.md <<<

import { windowActionsEn, windowActionsZh } from './window-actions-vocab';
import { updateCheckEn, updateCheckZh } from './update-check-vocab';
import { platformEn, platformZh } from './platform-settings-vocab';
import { pluginEn, pluginZh } from './plugins-vocab';
import { setupEn, setupZh } from './provider-setup-vocab';
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
  ...windowActionsZh,
};
