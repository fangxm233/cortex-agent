import * as RadixPopover from '@radix-ui/react-popover';
import { useState } from 'react';
import '@/design/content-surfaces.css';
import { defineModal } from '@/design/modal-registry';
import { useVocab } from '@/i18n';
import { MachineList } from './MachineList';
import { machinesChipLabel } from './machines-menu-vm';
import { useMachinesResource } from './useMachinesResource';

// The machines menu: a status chip in the top bar (online/total) that drops a glass sheet with
// the machine cards. Machines are window-scoped, so they live on the bar rather
// than beside any one pane. The open flag is a registry key so View → Machines can open it too.

const MONO = "'IBM Plex Mono',monospace";
const machinesMenu = defineModal('shell.machines', { requireProvider: false });

export function useMachinesMenuActions() {
  return machinesMenu.useModalActions();
}

function RackGlyph() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4.5h16v5.5H4zM4 14h16v5.5H4zM7.5 7.2h.01M7.5 16.8h.01M11 7.2h5M11 16.8h5" />
    </svg>
  );
}

function MenuHeader({ count, onManage }: { count: string; onManage: () => void }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 10px 18px', flex: 'none' }}>
      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.machines}</span>
      <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-muted)', background: 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)', padding: '2px 8px', borderRadius: 'var(--r-pill)' }}>{count}</span>
      <button type="button" className="content-text-action" onClick={onManage}
        style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}>
        {L.mManageMachines} ›
      </button>
    </div>
  );
}

function MenuBody({ count, expanded, onToggle, onManage }: {
  count: string;
  expanded: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onManage: () => void;
}) {
  return <>
    <MenuHeader count={count} onManage={onManage} />
    <MachineList expanded={expanded} onToggle={onToggle} />
  </>;
}

export function MachinesMenu({ onManage }: { onManage: () => void }): JSX.Element {
  const L = useVocab();
  const { isOpen, open, close } = machinesMenu.useModal();
  const roster = useMachinesResource();
  const label = machinesChipLabel(roster.machines, !roster.loading && !roster.error);
  const anyOnline = roster.machines.some((machine) => machine.online);
  const [hover, setHover] = useState(false);
  // Held above the sheet, which unmounts on close: reopening shows the same cards expanded, while
  // their probes stop with the sheet.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (name: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const title = `${L.machines} · ${label.online}${label.total}`;
  return (
    <RadixPopover.Root open={isOpen} onOpenChange={(next) => (next ? open() : close())}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          data-machines-menu=""
          aria-label={title}
          title={title}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 9px',
            border: 0,
            borderRadius: 'var(--r-chip)',
            background: isOpen ? 'var(--proto-accent-bg)' : hover ? 'var(--glass-2)' : 'var(--glass-1)',
            boxShadow: `0 0 0 1px ${isOpen ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
            color: anyOnline ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          <RackGlyph />
          <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-ink)' }}>
            {label.online}<span style={{ color: 'var(--proto-muted)' }}>{label.total}</span>
          </span>
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="content-surface"
          data-machines-sheet=""
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          style={{
            zIndex: 50,
            width: 360,
            maxHeight: 'min(640px, var(--radix-popover-content-available-height))',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: 'var(--r-float)',
            background: 'var(--glass-2)',
            backdropFilter: 'var(--glass-filter)',
            WebkitBackdropFilter: 'var(--glass-filter)',
            boxShadow: 'var(--shadow-float)',
            transformOrigin: 'var(--radix-popover-content-transform-origin)',
            animation: 'cxpop 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <MenuBody count={`${label.online}${label.total}`} expanded={expanded} onToggle={toggle}
            onManage={() => { close(); onManage(); }} />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
