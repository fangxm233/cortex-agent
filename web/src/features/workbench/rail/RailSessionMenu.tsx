import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { MENU_FOCUS, MENU_SURFACE, MONO } from '@/design/MenuChrome';
import { useLang } from '@/i18n';
import { workbenchCopy } from '@/features/workbench/workbench-copy';
import { SessionMetadata, type SessionMetadataActions } from '@/features/session/metadata/SessionMetadata';
import { SessionMetadataMenuItems } from '@/features/session/metadata/SessionMetadataMenuItems';
import type { RailSessionRow } from './rail-tree';

// Metadata dialogs have no Dialog.Trigger. Restore this row's trigger after their focus scope
// unmounts; the popover must not steal focus while handing off to the rename dialog.
function useDialogFocusReturn(dialogOpen: boolean, trigger: RefObject<HTMLButtonElement>) {
  const wasOpen = useRef(false);
  useEffect(() => {
    const closed = wasOpen.current && !dialogOpen;
    wasOpen.current = dialogOpen;
    if (!closed) return;
    const timer = setTimeout(() => trigger.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [dialogOpen, trigger]);
}

function MenuContent({ actions, close, trigger, label }: {
  actions: SessionMetadataActions; close: () => void; trigger: RefObject<HTMLButtonElement>; label: string;
}): JSX.Element {
  const dialogOpen = actions.renameOpen || !!actions.error;
  useDialogFocusReturn(dialogOpen, trigger);
  return <Popover.Portal>
    <Popover.Content aria-label={label} align="end" sideOffset={4}
      onCloseAutoFocus={(event) => { if (dialogOpen) event.preventDefault(); }}
      style={{ ...MENU_SURFACE, minWidth: 132, padding: 3, zIndex: 50,
        border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)' }}>
      <SessionMetadataMenuItems actions={actions} onClose={close} />
    </Popover.Content>
  </Popover.Portal>;
}

function TimeSlot({ age, visible, label, trigger }: {
  age: string; visible: boolean; label: string; trigger: RefObject<HTMLButtonElement>;
}): JSX.Element {
  return <>
    {/* Keep the age in flow, including long localized ages, so the title never jumps. */}
    <span style={{ visibility: visible ? 'hidden' : 'visible', font: `400 11px ${MONO}` }}>{age}</span>
    <Popover.Trigger asChild>
      <button ref={trigger} type="button" aria-label={label} title={label} className={MENU_FOCUS}
        style={{ position: 'absolute', right: 0, top: 0, width: 22, height: 22,
          padding: 0, border: 0, borderRadius: 'var(--r-chip)', fontSize: 15, lineHeight: 1,
          background: 'transparent', color: 'var(--proto-muted)', cursor: 'pointer',
          opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}>⋯</button>
    </Popover.Trigger>
  </>;
}

function useRailMenuState() {
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const [focused, setFocused] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  function onOpenChange(value: boolean) {
    if (value) setActivated(true);
    setOpen(value);
  }
  return { open, activated, focused, setFocused, trigger, onOpenChange };
}

export function RailSessionMenu({ row, hovered }: { row: RailSessionRow; hovered: boolean }): JSX.Element {
  const menu = useRailMenuState();
  const label = `${workbenchCopy(useLang()).sessionMenu}: ${row.title}`;
  return <span onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onFocus={() => menu.setFocused(true)} onBlur={() => menu.setFocused(false)}
    style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end',
      flex: 'none', minWidth: 22, height: 22, color: 'var(--proto-muted-2)' }}>
    {/* Catch clicks from both portals too. Leave pointerdown bubbling so Radix can reset its
        inside/outside tracking on document; stopping it breaks the next outside dismissal. */}
    <Popover.Root open={menu.open} onOpenChange={menu.onOpenChange}>
      <TimeSlot age={row.age} visible={hovered || menu.focused || menu.open} label={label} trigger={menu.trigger} />
      {/* Idle/hovered rows need no mutation providers. Once used, retain state across menu close,
          pending requests and the rename dialog's entire lifetime. */}
      {menu.activated && <SessionMetadata session={row}>
        {(actions) => <MenuContent actions={actions} close={() => menu.onOpenChange(false)}
          trigger={menu.trigger} label={label} />}
      </SessionMetadata>}
    </Popover.Root>
  </span>;
}
