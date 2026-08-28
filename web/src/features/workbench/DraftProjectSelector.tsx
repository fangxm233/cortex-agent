// input:  Shared current-project state, listed projects, and Select primitive
// output: Draft-only project scope selector for the desktop composer
// pos:    New-session project visibility and switching control
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { Select } from '@/design';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useVocab } from '@/i18n';

export function DraftProjectSelector({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const L = useVocab();
  const { currentProjectId, projects, setCurrentProject } = useCurrentProject();
  if (!currentProjectId) return null;

  const options = projects.map((project) => ({ value: project.id, label: project.id }));
  return (
    <div
      data-draft-project-selector
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '0 2px 10px' }}
    >
      <span style={{ color: 'var(--proto-faint)', font: "600 10px 'IBM Plex Mono',monospace", letterSpacing: '.06em', textTransform: 'uppercase' }}>
        {L.project}
      </span>
      <Select
        value={currentProjectId}
        options={options}
        onValueChange={setCurrentProject}
        placeholder={currentProjectId}
        disabled={disabled}
        aria-label={L.switchProject}
        style={{ minWidth: 170, padding: '5px 9px', border: '1px solid var(--proto-line)', background: 'var(--proto-rail)', color: 'var(--proto-ink)' }}
      />
    </div>
  );
}
