// input:  current mobile project, shared notes resource and navigation
// output: mobile notes view with shared CRUD and draft handoff
// pos:    Mobile composition owner for the scheme 26c notes screen
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotesResource } from '@/features/notes/useNotesResource';
import { useLang } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { prefillProjectDraft } from '@/features/workbench/composer-draft';
import { MNotesView } from './MNotesView';
import { buildMNotesVm } from './m-notes-vm';

export function MNotesScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const { currentProjectId } = useCurrentProject();
  const projectId = currentProjectId ?? '';
  const notes = useNotesResource(projectId);
  const vm = useMemo(() => buildMNotesVm(notes.notes, Date.now(), lang), [notes.notes, lang]);
  return (
    <MNotesView
      vm={vm}
      copy={NOTES_COPY[lang]}
      busy={notes.busy}
      onBack={() => navigate('/m/project')}
      onAdd={notes.add}
      onUpdate={notes.update}
      onSetCompleted={notes.setCompleted}
      onDelete={notes.delete}
      onClearCompleted={notes.clearCompleted}
      onHandoff={(text) => {
        prefillProjectDraft(projectId, text);
        navigate('/m/session/new');
      }}
    />
  );
}
