// input:  Profile control, composer hints and attach/command callbacks
// output: One desktop composer action row
// pos:    Groups profile, attach and command controls
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';

const CHIP_FONT = "500 10.5px 'IBM Plex Mono',monospace";
const HINT_FONT = "400 10.5px 'IBM Plex Mono',monospace";

function chipStyle(hover: boolean): CSSProperties {
  return {
    font: CHIP_FONT,
    border: `1px solid ${hover ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
    color: hover ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
    padding: '2px 7px',
    borderRadius: 6,
    cursor: 'pointer',
  };
}

export function ComposerActionRow({ profileControl, hint, onAttach, onCommands }: {
  profileControl: ReactNode;
  hint: string;
  onAttach: () => void;
  onCommands: () => void;
}): JSX.Element {
  const L = useVocab();
  const [attachHover, setAttachHover] = useState(false);
  const [commandsHover, setCommandsHover] = useState(false);
  return (
    <div data-composer-actions style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 0 }}>
      {profileControl}
      <span
        data-chip="attach"
        onClick={onAttach}
        onMouseEnter={() => setAttachHover(true)}
        onMouseLeave={() => setAttachHover(false)}
        style={chipStyle(attachHover)}
      >
        {L.wbAttach}
      </span>
      <span
        data-chip="commands"
        onClick={onCommands}
        onMouseEnter={() => setCommandsHover(true)}
        onMouseLeave={() => setCommandsHover(false)}
        style={chipStyle(commandsHover)}
      >
        / {L.commands}
      </span>
      <span style={{ marginLeft: 'auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', font: HINT_FONT, color: 'var(--proto-faint)' }}>{hint}</span>
    </div>
  );
}
