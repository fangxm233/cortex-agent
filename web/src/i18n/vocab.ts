// input:  language chunks and plugin copy tables
// output: merged bilingual vocabulary and Vocab type
// pos:    Web vocabulary composition root
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { pluginEn, pluginZh } from './plugins-vocab';
import { enBase } from './vocab-en-base';
import { enExtra } from './vocab-en-extra';
import { zhBase } from './vocab-zh-base';
import { zhExtra } from './vocab-zh-extra';

export const en = {
  ...enBase,
  ...pluginEn,
  ...enExtra,
};

export type Vocab = typeof en;

export const zh: Record<keyof Vocab, string> = {
  ...zhBase,
  ...pluginZh,
  ...zhExtra,
};
