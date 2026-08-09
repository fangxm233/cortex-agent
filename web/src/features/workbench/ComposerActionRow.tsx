// input:  Profile control, slash suggestions and action callbacks
// output: Desktop composer action row and slash menu
// pos:    Groups composer shortcuts and controls
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import type { SlashSuggestion } from './composer-slash';

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

export function ComposerSlashMenu({ suggestions, onPick }: {
  suggestions: SlashSuggestion[];
  onPick: (suggestion: SlashSuggestion) => void;
}): JSX.Element | null {
  const L = useVocab();
  const [hovered, setHovered] = useState<number | null>(null);
  if (suggestions.length === 0) return null;
  return (
    <div data-menu="slash" style={{ position: 'absolute', left: 32, right: 32, bottom: '100%', marginBottom: -2, border: '1px solid var(--proto-line)', borderRadius: 12, boxShadow: '0 6px 24px rgba(16,24,40,.08)', background: 'var(--proto-card)', overflow: 'hidden', zIndex: 10 }}>
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.command}
          data-slash-command={suggestion.command}
          onMouseEnter={() => setHovered(index)}
          onMouseLeave={() => setHovered((value) => value === index ? null : value)}
          onClick={() => { if (!suggestion.disabled) onPick(suggestion); }}
          style={{ display: 'flex', alignItems: 'center', padding: '8px 14px', opacity: suggestion.disabled ? 0.45 : 1, background: hovered === index || index === 0 ? 'var(--proto-accent-bg)' : 'var(--proto-card)', cursor: suggestion.disabled ? 'default' : 'pointer' }}
        >
          <span style={{ font: "600 12px 'IBM Plex Mono',monospace", color: index === 0 ? 'var(--proto-accent)' : 'var(--proto-muted)' }}>{suggestion.command}</span>
          <span style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', marginLeft: 12 }}>{suggestion.description}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', padding: '7px 14px', borderTop: '1px solid var(--proto-alt)', background: 'var(--proto-rail)' }}>
        <span style={{ font: "400 10px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)' }}>↑↓ {L.wbNavigate} · ⏎ {L.wbRun} · {L.wbEscDismiss}</span>
      </div>
    </div>
  );
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
