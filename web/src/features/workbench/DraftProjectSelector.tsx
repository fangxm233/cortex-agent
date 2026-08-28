// input:  Shared current-project state, left-rail order, and bilingual vocabulary
// output: Profile-styled project chip and ordered draft project menu
// pos:    New-session project visibility and switching control
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useState } from 'react';
import type { ProjectConduitInfo } from '@cortex-agent/ui-contract';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useVocab } from '@/i18n';

const CHIP_FONT = "500 11.5px 'IBM Plex Mono',monospace";
const MONO = "'IBM Plex Mono',monospace";

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
    <div data-menu="project" style={{ position: 'absolute', left: 0, bottom: 36, minWidth: 200, background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 8, boxShadow: 'var(--shadow-menu)', zIndex: 59, overflow: 'hidden' }}>
      {projects.map((project) => (
        <div
          key={project.id}
          data-project={project.id}
          onMouseEnter={() => setHover(project.id)}
          onMouseLeave={() => setHover((id) => id === project.id ? null : id)}
          onClick={(event) => { event.stopPropagation(); onPick(project.id); }}
          style={{ display: 'flex', alignItems: 'center', padding: '5px 8px', cursor: 'pointer', background: hover === project.id ? 'var(--proto-gray)' : project.id === current ? 'var(--proto-accent-bg)' : 'transparent' }}
        >
          <span style={{ font: `600 10px ${MONO}`, color: 'var(--proto-ink)' }}>{project.id}</span>
          {project.id === current && <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>}
        </div>
      ))}
    </div>
  );
}

export function DraftProjectSelector({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const L = useVocab();
  const { currentProjectId, projects, projectOrder, setCurrentProject } = useCurrentProject();
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', close); };
  }, [open]);
  if (!currentProjectId) return null;

  const orderedProjects = orderDraftProjects(projects, projectOrder);
  return (
    <span
      data-chip="project"
      aria-label={L.switchProject}
      aria-disabled={disabled || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => { event.stopPropagation(); if (!disabled) setOpen((value) => !value); }}
      style={{ position: 'relative', font: CHIP_FONT, border: `1.5px solid ${hover && !disabled ? 'var(--proto-accent-border)' : 'var(--proto-line-3)'}`, color: hover && !disabled ? 'var(--proto-accent)' : 'var(--proto-muted)', padding: '0 12px', height: 30, borderRadius: 999, boxSizing: 'border-box', cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', opacity: disabled ? 0.55 : 1, margin: '0 auto 10px', width: 'fit-content' }}
    >
      {L.project} · {currentProjectId}
      {open && <ProjectMenu projects={orderedProjects} current={currentProjectId} onPick={(id) => { setOpen(false); setCurrentProject(id); }} />}
    </span>
  );
}
