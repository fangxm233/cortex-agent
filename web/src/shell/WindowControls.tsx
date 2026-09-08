// input:  native window actions and the current maximize state
// output: the minimize / maximize / close caption buttons
// pos:    App-drawn window controls for Windows and Linux
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState } from 'react';
import { useVocab } from '@/i18n';
import { desktopPlatform } from '@/lib/desktop-platform';
import type { WindowActions } from './menu/useWindowActions';

// 46px wide, full bar height, no gap — the Windows caption convention, which Linux desktops read
// as "this app draws its own chrome" too. macOS never renders these: it keeps native decorations
// under TitleBarStyle::Overlay, so its traffic lights are real.
//
// Glyphs: Windows has the Segoe Fluent icon font, and using it keeps the buttons pixel-identical to
// every other app on the system. Linux has no such guarantee, so it gets inline SVG.
const SEGOE = { minimize: '', maximize: '', restore: '', close: '' };

function Glyph({ name }: { name: keyof typeof SEGOE }): JSX.Element {
  if (desktopPlatform() === 'windows') {
    return <span style={{ fontFamily: "'Segoe Fluent Icons','Segoe MDL2 Assets',sans-serif", fontSize: 10 }}>{SEGOE[name]}</span>;
  }
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 } as const;
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      {name === 'minimize' && <line x1="1.5" y1="6" x2="10.5" y2="6" {...stroke} />}
      {name === 'maximize' && <rect x="1.8" y="1.8" width="8.4" height="8.4" {...stroke} />}
      {name === 'restore' && (
        <>
          <rect x="1.5" y="3.4" width="7" height="7" {...stroke} />
          <path d="M3.9 3.4V1.5h6.6v6.6H8.6" {...stroke} />
        </>
      )}
      {name === 'close' && <path d="M2 2l8 8M10 2l-8 8" {...stroke} />}
    </svg>
  );
}

function CaptionButton({ label, danger, onClick, children }: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 46,
        alignSelf: 'stretch',
        border: 0,
        padding: 0,
        cursor: 'default',
        display: 'grid',
        placeItems: 'center',
        background: hover ? (danger ? 'var(--caption-close-hover)' : 'var(--caption-hover)') : 'transparent',
        color: hover && danger ? 'var(--caption-close-hover-fg)' : 'var(--proto-ink)',
      }}
    >
      {children}
    </button>
  );
}

export function WindowControls({ actions }: { actions: WindowActions }): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flex: 'none', alignSelf: 'stretch' }}>
      <CaptionButton label={L.winMinimize} onClick={actions.minimize}><Glyph name="minimize" /></CaptionButton>
      <CaptionButton
        label={actions.isMaximized ? L.winRestore : L.winMaximize}
        onClick={actions.toggleMaximize}
      >
        <Glyph name={actions.isMaximized ? 'restore' : 'maximize'} />
      </CaptionButton>
      <CaptionButton label={L.winClose} danger onClick={actions.close}><Glyph name="close" /></CaptionButton>
    </div>
  );
}
