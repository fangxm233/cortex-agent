import { useCallback, useState } from 'react';
import type { useNavigate } from 'react-router-dom';
import { useCreateProject } from '@/features/projects/useCreateProject';
import { finishMobileProjectCreation } from './m-new-project-flow';
import { MNewProjectView } from './MNewProjectView';

export function useNewProjectSheet(
  navigate: ReturnType<typeof useNavigate>,
  setCurrentProject: (id: string) => void,
) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const onCreated = useCallback((id: string) => {
    finishMobileProjectCreation(id, { setCurrentProject, close, navigate });
  }, [close, navigate, setCurrentProject]);
  const create = useCreateProject({ onCreated });
  const setProjectName = useCallback((value: string) => {
    setName(value);
    create.clearError();
  }, [create.clearError]);
  const submit = useCallback(() => {
    void create.createProject(name);
  }, [create.createProject, name]);
  const show = useCallback(() => {
    setName('');
    create.clearError();
    setOpen(true);
  }, [create.clearError]);
  return {
    open, name, setName: setProjectName, submit, close, show,
    error: create.error,
    pending: create.isPending,
  };
}

export type NewProjectSheet = ReturnType<typeof useNewProjectSheet>;

export function MNewProjectSheet({ project }: { project: NewProjectSheet }) {
  if (!project.open) return null;
  return <MNewProjectView name={project.name} onNameChange={project.setName} onCreate={project.submit}
    onClose={project.close} error={project.error} pending={project.pending} />;
}
