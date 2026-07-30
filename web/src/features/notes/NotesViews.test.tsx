// input:  notes button/card/pane views and neutral NoteInfo fixtures
// output: persistent entry and click-selected action regressions
// pos:    Tests desktop project notes views
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { NotesButton } from './NotesButton';
import { NotesOverviewCard } from './NotesOverviewCard';
import { NotesPaneView } from './NotesPane';
import { NOTES_COPY } from './notes-copy';
import { buildNotesVm } from './notes-vm';

const note = (id: string, completed = false): NoteInfo => ({
  id,
  text: `${id} reminder`,
  completed,
  createdAt: '2026-07-29T17:41:00.000Z',
  updatedAt: '2026-07-29T17:41:00.000Z',
  completedAt: completed ? '2026-07-29T17:50:00.000Z' : null,
});

const noop = () => {};

it('renders the desktop notes entry even when the active count is zero', () => {
  const html = renderToStaticMarkup(
    <NotesButton count={0} active={false} copy={NOTES_COPY.en} onClick={noop} />,
  );
  expect(html).toContain('data-notes-button');
  expect(html).toContain('Notes');
  expect(html).toContain('>0<');
});

it('renders the Overview quick-add card at zero notes', () => {
  const vm = buildNotesVm([], Date.now(), 'en');
  const html = renderToStaticMarkup(
    <NotesOverviewCard vm={vm} copy={NOTES_COPY.en} onOpen={noop} onAdd={async () => {}} />,
  );
  expect(html).toContain('data-notes-overview-card');
  expect(html).toContain('Note something to do');
  expect(html).toContain('context/NOTES.md');
});

it('keeps desktop rows compact until a note is selected', () => {
  const vm = buildNotesVm([note('active')], Date.now(), 'en');
  const html = renderToStaticMarkup(
    <NotesPaneView
      vm={vm}
      copy={NOTES_COPY.en}
      busy={false}
      targetId={null}
      onSelect={noop}
      onClose={noop}
      onAdd={async () => {}}
      onUpdate={async () => {}}
      onSetCompleted={async () => {}}
      onDelete={async () => {}}
      onHandoff={noop}
      onClearCompleted={async () => {}}
    />,
  );
  expect(html).not.toContain('data-note-actions="active"');
  expect(html).not.toContain('Hand to agent');
  expect(html).not.toContain('Edit');
  expect(html).not.toContain('Delete');
});

it('renders active and completed sections with selected note actions', () => {
  const vm = buildNotesVm([note('active'), note('done', true)], Date.now(), 'en');
  const html = renderToStaticMarkup(
    <NotesPaneView
      vm={vm}
      copy={NOTES_COPY.en}
      busy={false}
      targetId="active"
      onSelect={noop}
      onClose={noop}
      onAdd={async () => {}}
      onUpdate={async () => {}}
      onSetCompleted={async () => {}}
      onDelete={async () => {}}
      onHandoff={noop}
      onClearCompleted={async () => {}}
    />,
  );
  expect(html).toContain('data-notes-pane');
  expect(html).toContain('data-note-target="active"');
  expect(html).toContain('data-note-actions="active"');
  expect(html).toContain('Hand to agent');
  expect(html).toContain('Edit');
  expect(html).toContain('Delete');
  expect(html).toContain('Completed · 1');
  expect(html).toContain('Clear');
});
