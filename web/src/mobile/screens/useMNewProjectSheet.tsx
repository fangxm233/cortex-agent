import { useCallback, useState } from 'react';
import type { useNavigate } from 'react-router-dom';
import { pickCopy } from '@/mobile/ui/format';
import { useCreateProject } from '@/features/projects/useCreateProject';
import { finishMobileProjectCreation } from './m-new-project-flow';
import { MNewProjectView, type MNewProjectCopy } from './MNewProjectView';

const NEW_PROJECT_COPY: { en: MNewProjectCopy; zh: MNewProjectCopy } = {
  en: {
    title: 'New project',
    placeholder: 'Project name, e.g. rl-locomotion',
    create: 'Create and start a chat',
  },
  zh: {
    title: '新建项目',
    placeholder: '项目名字，如 rl-locomotion',
    create: '创建并开始对话',
  },
};

export function useNewProjectSheet(
  lang: 'en' | 'zh',
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
    copy: pickCopy(lang, NEW_PROJECT_COPY),
    error: create.error,
    pending: create.isPending,
  };
}

export type NewProjectSheet = ReturnType<typeof useNewProjectSheet>;

export function MNewProjectSheet({ project }: { project: NewProjectSheet }) {
  if (!project.open) return null;
  return <MNewProjectView name={project.name} onNameChange={project.setName} onCreate={project.submit}
    onClose={project.close} copy={project.copy} error={project.error} pending={project.pending} />;
}
