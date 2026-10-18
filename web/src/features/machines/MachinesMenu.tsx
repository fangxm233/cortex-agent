import * as RadixPopover from '@radix-ui/react-popover';
import { useState } from 'react';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import '@/design/content-surfaces.css';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { defineModal } from '@/design/modal-registry';
import { useLang, useVocab } from '@/i18n';
import { MachineList } from './MachineList';
import { machinesChipLabel, machinesOnlineText } from './machines-menu-vm';
import { MACHINES_TONE_COLOR, machinesStatusTone } from './machines-status';
import { useMachinesResource } from './useMachinesResource';

// The machines menu: a server button in the top bar (status dot + online/total) that drops a
// glass sheet with the machine cards. Machines are window-scoped, so they live on the bar rather
// than beside any one pane. The open flag is a registry key so View → Machines can open it too.

const machinesMenu = defineModal('shell.machines', { requireProvider: false });

export function useMachinesMenuActions() {
  return machinesMenu.useModalActions();
}

function RackGlyph() {
  return (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <rect x="3" y="3.5" width="18" height="7" rx="2" />
      <rect x="3" y="13.5" width="18" height="7" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  );
}

// The sheet's header is a title, a plain count and a link — the count is a fact, not a badge.
function MenuHeader({ machines, known, onManage }: { machines: MachineInfo[]; known: boolean; onManage: () => void }) {
  const L = useVocab();
  const count = machinesOnlineText(machines, known, useLang());
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '14px 16px 6px', flex: 'none' }}>
      <span style={{ fontSize: 14, fontWeight: 620, color: 'var(--proto-ink)' }}>{L.machines}</span>
      <span data-machines-count="" style={{ fontSize: 12.5, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      <button type="button" className="content-text-action" onClick={onManage}
        style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 500, color: 'var(--proto-accent)', cursor: 'pointer' }}>
        {L.mManageMachines} ›
      </button>
    </div>
  );
}

function MenuBody({ machines, known, expanded, onToggle, onManage }: {
  machines: MachineInfo[];
  known: boolean;
  expanded: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onManage: () => void;
}) {
  return <>
    <MenuHeader machines={machines} known={known} onManage={onManage} />
    <MachineList expanded={expanded} onToggle={onToggle} />
  </>;
}

export function MachinesMenu({ onManage }: { onManage: () => void }): JSX.Element {
  const L = useVocab();
  const { isOpen, open, close } = machinesMenu.useModal();
  const roster = useMachinesResource();
  const label = machinesChipLabel(roster.machines, !roster.loading && !roster.error);
  const tone = machinesStatusTone(roster.machines, !roster.loading && !roster.error);
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
          className={MENU_FOCUS}
          style={{
            // A transparent icon button like its neighbours, widened only by the count; open is the
            // same quiet tint as any engaged icon button.
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            height: 32,
            padding: '0 10px 0 8px',
            border: 0,
            borderRadius: 'var(--r-chip)',
            background: isOpen ? 'var(--proto-gray)' : hover ? 'var(--proto-line-2)' : 'transparent',
            color: isOpen || hover ? 'var(--proto-ink)' : 'var(--proto-ink-3)',
            font: '550 13px var(--font-ui)',
            fontVariantNumeric: 'tabular-nums',
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          <RackGlyph />
          {tone !== 'unknown' && (
            // On the glyph's lower-right corner, ringed in the ground colour so it reads as a badge.
            <span
              aria-hidden="true"
              data-machines-tone={tone}
              style={{
                position: 'absolute', left: 20, bottom: 7, width: 7, height: 7, borderRadius: '50%',
                background: MACHINES_TONE_COLOR[tone], boxShadow: '0 0 0 2px var(--proto-base)',
              }}
            />
          )}
          <span>{label.online}{label.total}</span>
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
            // Opaque card, not glass. Radix's popper wrapper carries `will-change: transform`, which
            // makes it a backdrop root: a backdrop-filter on the sheet would blur nothing, and a
            // translucent fill let the chat header's icons, right under the sheet's header, read
            // straight through it.
            background: 'var(--proto-card)',
            boxShadow: 'var(--material-overlay-shadow), 0 0 0 1px var(--proto-line)',
            transformOrigin: 'var(--radix-popover-content-transform-origin)',
            animation: 'cxpop 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <MenuBody machines={roster.machines} known={!roster.loading && !roster.error} expanded={expanded} onToggle={toggle}
            onManage={() => { close(); onManage(); }} />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
