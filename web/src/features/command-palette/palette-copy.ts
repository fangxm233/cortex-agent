import type { Lang } from '@/i18n';

// Palette chrome and the row kind tags (`PaletteRow.kbd` stays the stable tag; this is its label).
const en = {
  label: 'Command palette',
  close: 'Close command palette',
  kinds: { command: 'command', session: 'session', thread: 'thread', task: 'task', page: 'page', modal: 'modal' } as Record<string, string>,
};

export type PaletteCopy = typeof en;

const zh: PaletteCopy = {
  label: '命令面板',
  close: '关闭命令面板',
  kinds: { command: '命令', session: '会话', thread: '线程', task: '任务', page: '页面', modal: '弹窗' },
};

export const PALETTE_COPY: Record<Lang, PaletteCopy> = { en, zh };

/** The localized kind tag; an unknown tag shows as-is. */
export function paletteKindText(kind: string, copy: PaletteCopy): string {
  return copy.kinds[kind] ?? kind;
}
