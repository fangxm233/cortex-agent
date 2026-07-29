// input:  mobile project notes card with an empty view model
// output: zero-count persistent entry and quick-input regressions
// pos:    Tests scheme 26a mobile Overview notes entry
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { MNotesProjectCard } from './MNotesProjectCard';
import { buildMNotesVm } from './m-notes-vm';

it('stays visible at zero notes and exposes a quick input', () => {
  const html = renderToStaticMarkup(
    <MNotesProjectCard
      vm={buildMNotesVm([], Date.now(), 'zh')}
      copy={NOTES_COPY.zh}
      busy={false}
      onOpen={() => {}}
      onAdd={async () => {}}
    />,
  );
  expect(html).toContain('data-mobile-notes-card');
  expect(html).toContain('>0<');
  expect(html).toContain('快速记一条');
});
