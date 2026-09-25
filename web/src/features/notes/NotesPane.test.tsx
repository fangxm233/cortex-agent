// input:  NotesPaneView, static renderer, synthetic notes
// output: Completed-note readability regression
// pos:    Notes pane presentation test
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { NotesPaneView } from './NotesPane';
import { NOTES_COPY } from './notes-copy';
import { buildNotesVm } from './notes-vm';

vi.mock('./NotesProvider', () => ({ useNotes: () => ({}) }));

it('retains completed text, timestamp and reopen action without dimming the row', () => {
  const iso = '2030-01-01T12:00:00Z';
  const vm = buildNotesVm([{ id: 'example', text: 'Completed example', completed: true,
    createdAt: iso, updatedAt: iso, completedAt: iso }], Date.parse(iso), 'en');
  const noop = () => {};
  const mutation = async () => {};
  const html = renderToStaticMarkup(<NotesPaneView vm={vm} copy={NOTES_COPY.en}
    busy={false} targetId={null} onSelect={noop} onClose={noop} onHandoff={noop}
    onAdd={mutation} onUpdate={mutation} onSetCompleted={mutation}
    onDelete={mutation} onClearCompleted={mutation} />);
  expect(html).toContain('Completed example');
  expect(html).toContain(vm.completed[0].timeLabel);
  expect(html).toContain('aria-label="reopen note"');
  expect(html).toContain('text-decoration:line-through');
  expect(html).not.toContain('opacity:');
  expect(html).not.toContain('var(--proto-faint)');
});
