// input:  mobile notes view, shared copy and note fixtures
// output: full-page list, tap/swipe and composer render regressions
// pos:    Tests mobile notes presentation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { MNotesView } from './MNotesView';
import { buildMNotesVm } from './m-notes-vm';

const notes: NoteInfo[] = [
  { id: 'open', text: 'Run evaluation', completed: false, createdAt: '2026-07-29T17:41:00Z', updatedAt: '2026-07-29T17:41:00Z', completedAt: null },
  { id: 'done', text: 'Fix port', completed: true, createdAt: '2026-07-28T17:41:00Z', updatedAt: '2026-07-29T17:41:00Z', completedAt: '2026-07-29T17:41:00Z' },
];
const noop = () => {};

it('renders a non-tab notes page with tappable rows and a fixed quick composer', () => {
  const html = renderToStaticMarkup(
    <MNotesView
      vm={buildMNotesVm(notes, Date.parse('2026-07-29T18:00:00Z'), 'zh')}
      copy={NOTES_COPY.zh}
      busy={false}
      onBack={noop}
      onAdd={async () => {}}
      onUpdate={async () => {}}
      onSetCompleted={async () => {}}
      onDelete={async () => {}}
      onHandoff={noop}
      onClearCompleted={async () => {}}
    />,
  );
  expect(html).toContain('data-screen-label="26c 移动端笔记"');
  expect(html).toContain('data-note-click="open"');
  expect(html).not.toContain('data-note-long-press');
  expect(html).toContain('data-note-swipe="open"');
  expect(html).toContain('已完成 · 1');
  expect(html).toContain('data-notes-fixed-composer');
  expect(html).toContain('context/NOTES.md');
});
