import * as Popover from '@radix-ui/react-popover';
import { useState } from 'react';
import { MENU_BUTTON_STYLE, MENU_FOCUS, MENU_SURFACE } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { useDeleteProject } from '@/features/projects/useDeleteProject';

const TRIGGER_SIZE = 24;

/** A project row's ⋯ menu. Stays mounted while the row is not hovered so an open menu survives the
 *  pointer moving into its portal. */
function MenuContent({ projectId, sessionCount, label, close }: {
  projectId: string; sessionCount: number; label: string; close: () => void;
}): JSX.Element {
  const L = useVocab();
  const deleteProject = useDeleteProject();
  return <Popover.Portal>
    <Popover.Content aria-label={label} align="end" sideOffset={4}
      style={{ ...MENU_SURFACE, minWidth: 132, padding: 3, zIndex: 50,
        border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)' }}>
      <button type="button" className={MENU_FOCUS}
        onClick={() => { close(); void deleteProject(projectId, sessionCount); }}
        style={{ ...MENU_BUTTON_STYLE, background: 'transparent', color: 'var(--proto-danger)',
          padding: '9px 13px', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }}>{L.projDelete}</button>
    </Popover.Content>
  </Popover.Portal>;
}

/** A project row's ⋯ menu. Stays mounted while the row is not hovered so an open menu survives the
 *  pointer moving into its portal; the mutation side mounts on first open, so idle rows need no
 *  query providers. */
export function RailProjectMenu({ projectId, sessionCount, visible }: {
  projectId: string; sessionCount: number; visible: boolean;
}): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const label = `${L.projMenu}: ${projectId}`;
  const onOpenChange = (value: boolean) => { if (value) setActivated(true); setOpen(value); };
  return <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
    style={{ display: visible || open ? 'inline-flex' : 'none' }}>
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={label} title={label} className={MENU_FOCUS}
          style={{ width: TRIGGER_SIZE, height: TRIGGER_SIZE, padding: 0, border: 0, borderRadius: 6,
            fontSize: 15, lineHeight: 1, cursor: 'pointer', color: 'var(--proto-muted)',
            background: open ? 'var(--proto-line-2)' : 'transparent' }}>⋯</button>
      </Popover.Trigger>
      {activated && <MenuContent projectId={projectId} sessionCount={sessionCount} label={label}
        close={() => setOpen(false)} />}
    </Popover.Root>
  </span>;
}
