import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotesResource } from '@/features/notes/useNotesResource';
import { useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { prefillProjectDraft } from '@/features/session/composer/composer-draft';
import { MNotesView } from './MNotesView';
import { buildMNotesVm } from './m-notes-vm';

export function MNotesScreen() {
  const navigate = useNavigate();
  const L = useVocab();
  const { currentProjectId } = useCurrentProject();
  const projectId = currentProjectId ?? '';
  const notes = useNotesResource(projectId);
  const vm = useMemo(() => buildMNotesVm(notes.notes, Date.now(), L), [notes.notes, L]);
  return (
    <MNotesView
      vm={vm}
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
