// >>> Keep en and zh keys in lockstep (zh is typed against keyof typeof langEn) <<<

export const langEn = {
  'lang.current': 'Current language: *${lang}*',
  'lang.switched': 'Language switched to *${lang}*.',
  'lang.usage': 'Usage: `!lang <en|zh>`',
  'lang.available': 'Available languages: `en` (English), `zh` (中文)',
  'lang.unknown': 'Unknown language `${lang}`. Available: `en`, `zh`.',
} as const;

export const langZh: Record<keyof typeof langEn, string> = {
  'lang.current': '当前语言：*${lang}*',
  'lang.switched': '已切换语言为 *${lang}*。',
  'lang.usage': '用法：`!lang <en|zh>`',
  'lang.available': '可用语言：`en`（English）、`zh`（中文）',
  'lang.unknown': '未知语言 `${lang}`。可用：`en`、`zh`。',
};
