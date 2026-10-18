import { useState } from 'react';
import { MenuCard, MENU_BUTTON_STYLE, MENU_FOCUS, MENU_ROW_PAD_X, useDismissMenu } from '@/design/MenuChrome';
import type { ProjectConduitInfo } from '@cortex-agent/ui-contract';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useVocab } from '@/i18n';
import { ProjectGlyph, quietChipStyle } from './composer-chip';

export function orderDraftProjects(
  projects: ProjectConduitInfo[],
  projectOrder: string[],
): ProjectConduitInfo[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ordered = projectOrder.flatMap((id) => byId.get(id) ?? []);
  const included = new Set(ordered.map((project) => project.id));
  return [...ordered, ...projects.filter((project) => !included.has(project.id))];
}

function ProjectMenu({ projects, current, onPick }: {
  projects: ProjectConduitInfo[];
  current: string;
  onPick: (id: string) => void;
}): JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <MenuCard kind="project" align="left" minWidth={200}>
      {projects.map((project) => (
        <button
          type="button"
          className={MENU_FOCUS}
          aria-pressed={project.id === current}
          key={project.id}
          data-project={project.id}
          onMouseEnter={() => setHover(project.id)}
          onMouseLeave={() => setHover((id) => id === project.id ? null : id)}
          onClick={(event) => { event.stopPropagation(); onPick(project.id); }}
          style={{ ...MENU_BUTTON_STYLE, display: 'flex', alignItems: 'center', padding: `7px ${MENU_ROW_PAD_X}px`, cursor: 'pointer', background: hover === project.id ? 'var(--proto-gray)' : project.id === current ? 'var(--proto-line-2)' : 'transparent' }}
        >
          <span style={{ font: `${project.id === current ? 550 : 400} 13px var(--font-ui)`, color: 'var(--proto-ink)' }}>{project.id}</span>
          {project.id === current && <span style={{ marginLeft: 'auto', color: 'var(--proto-ink)', fontSize: 12, fontWeight: 700 }}>✓</span>}
        </button>
      ))}
    </MenuCard>
  );
}

export function DraftProjectSelector({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const L = useVocab();
  const { currentProjectId, projects, projectOrder, setCurrentProject } = useCurrentProject();
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useDismissMenu(open, close, close);
  if (!currentProjectId) return null;

  const orderedProjects = orderDraftProjects(projects, projectOrder);
  return (
    <span style={{ position: 'relative', display: 'block', margin: '0 auto 10px', width: 'fit-content' }}>
      <button
        type="button"
        className={MENU_FOCUS}
        disabled={disabled}
        aria-expanded={open}
        data-chip="project"
        aria-label={L.switchProject}
        aria-disabled={disabled || undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={(event) => { event.stopPropagation(); if (!disabled) setOpen((value) => !value); }}
        style={{ ...quietChipStyle((hover || open) && !disabled), display: 'flex', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1, width: 'fit-content', whiteSpace: 'nowrap' }}
      >
        <ProjectGlyph />
        {L.project} · {currentProjectId}
      </button>
      {open && <ProjectMenu projects={orderedProjects} current={currentProjectId} onPick={(id) => { setOpen(false); setCurrentProject(id); }} />}
    </span>
  );
}
