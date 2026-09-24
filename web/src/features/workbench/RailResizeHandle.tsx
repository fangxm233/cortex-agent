// input:  rail width band, language
// output: RailResizeHandle
// pos:    Drag divider in the gutter between the left rail and the workspace
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MAX, RAIL_WIDTH_MIN, clampRailWidth } from './rail-width';

// The rail and the workspace are separate floating panes, so the divider fills the gutter between
// them instead of sitting on either pane's rim — the rail's own right edge is where its tree
// scrollbar lives. It stays invisible until hovered; a thin line then marks the grip. Pointer
// capture keeps the drag alive when the pointer crosses an embedded web page in the dock, which
// would otherwise swallow the move events. Double-click restores the default width.

const COPY = {
  zh: '拖动调整侧栏宽度，双击恢复默认',
  en: 'Drag to resize the sidebar, double-click to reset',
};

export function RailResizeHandle({ width, onResize }: {
  width: number;
  /** Every width the drag passes through; `done` marks the final one, which is the one to persist. */
  onResize: (width: number, done: boolean) => void;
}): JSX.Element {
  const label = useLang() === 'zh' ? COPY.zh : COPY.en;
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const end = (): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActive(false);
    document.body.style.userSelect = '';
    onResize(d.last, true);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={RAIL_WIDTH_MIN}
      aria-valuemax={RAIL_WIDTH_MAX}
      title={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { startX: e.clientX, startW: width, last: width };
        setActive(true);
        document.body.style.userSelect = 'none';
        onResize(width, false);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const next = clampRailWidth(d.startW + e.clientX - d.startX);
        if (next === d.last) return;
        d.last = next;
        onResize(next, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onResize(RAIL_WIDTH_DEFAULT, true)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute', top: 0, bottom: 0, left: '100%', width: 'var(--app-gutter)', zIndex: 3,
        display: 'flex', justifyContent: 'center', cursor: 'col-resize', touchAction: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 2, margin: '14px 0', borderRadius: 1,
          background: 'var(--proto-muted)',
          opacity: active ? 0.7 : hover ? 0.35 : 0,
          transition: 'opacity .16s ease',
        }}
      />
    </div>
  );
}
