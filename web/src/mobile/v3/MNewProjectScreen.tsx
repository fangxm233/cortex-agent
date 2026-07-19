// 1i 新建项目 — the "new project" bottom sheet, presented as its own drill route /m/new-project
// (opened from 1e's ＋ 新建项目). scheme-mobile.dc.html 1i L509-518. Dismiss → back to /m/project.
// On create: the REAL projects.create mutation ({ name }); on success invalidate projects.list and
// jump into a fresh chat draft (/m/session/new) so mission/templates/budget get initialized by the
// agent via project_init in the first conversation. The button is disabled while the name is empty.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MNewProjectView } from './MNewProjectView';
import { MProjectScreen } from './MProjectScreen';
import { canCreate, type MNewProjectCopy } from './m-new-project-vm';

const COPY: { en: MNewProjectCopy; zh: MNewProjectCopy } = {
  en: {
    title: 'New project',
    tag: 'projects/',
    placeholder: 'Project name, e.g. rl-locomotion',
    hintA: 'Only creates ',
    hintB: ' and an empty CORTEX.md — mission, templates, and budget are initialized by the agent via ',
    hintC: ' in the first conversation',
    create: 'Create and start a chat',
  },
  zh: {
    title: '新建项目',
    tag: 'projects/',
    placeholder: '项目名字，如 rl-locomotion',
    hintA: '只创建 ',
    hintB: ' 和空 CORTEX.md — mission、模板、预算在第一次对话里由 agent 通过 ',
    hintC: ' 初始化',
    create: '创建并开始对话',
  },
};

export function MNewProjectScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const [name, setName] = useState('');

  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.projects.list.queryFilter());
        // Enter a fresh chat draft for the new project (mission/templates/budget → first conversation).
        navigate('/m/session/new');
      },
    }),
  );

  const submit = () => {
    if (!canCreate(name) || create.isPending) return;
    create.mutate({ name: name.trim() });
  };

  // Render the real 项目 page behind the sheet (its own tRPC data, from cache since we came from it)
  // so this reads as a modal that pops up OVER the project page — not a standalone screen. It sits
  // under the sheet's dim and is non-interactive (the dim overlay swallows taps). No fabrication.
  const behind = <MProjectScreen />;

  return (
    <MNewProjectView
      name={name}
      onNameChange={setName}
      onCreate={submit}
      onClose={() => navigate('/m/project')}
      copy={copy}
      behind={behind}
    />
  );
}
