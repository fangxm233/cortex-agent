import { useState } from 'react';
import type { SwitchProjectRow } from './project-menu';
import { useVocab } from '@/i18n';

// Project-card dropdown — 1:1 from prototype.dc.html L1565–1607 (task c3ce). Raw inline styles /
// px / hex / font / weight / EN copy reproduced verbatim; real projects.list substituted into the
// design's exact structure. Fixed-position overlay (click-catcher z-58 / menu z-59) anchored at
// left:10px;top:106px — matching the LeftRail project card. Esc-close is wired by the host.
//
// A project row click updates the shared cross-pane current-project state (task 569c): onSwitch(id)
// re-scopes the LeftRail project card + cost and the RightPanel cost bar (pure front-end selection;
// no backend switch op). DATA GAP (flagged): per-row phase vocabulary ("M3.1 · idle"/"paused") has
// no backing field → meta = real running count (else "idle").

const mono = "'IBM Plex Mono',monospace";

export function ProjectMenu({
  projName,
  projInitials,
  subLabel,
  rows,
  onClose,
  onOpenOverview,
  onSwitch,
  onNewProject,
}: {
  projName: string;
  projInitials: string;
  subLabel: string;
  rows: SwitchProjectRow[];
  onClose: () => void;
  onOpenOverview: () => void;
  onSwitch: (id: string) => void;
  onNewProject: () => void;
}): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState<string | null>(null);
  const hp = (key: string) => ({
    onMouseEnter: () => setHover(key),
    onMouseLeave: () => setHover((h) => (h === key ? null : h)),
  });

  return (
    <>
      {/* full-screen click-catcher (prototype L1566) */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 58 }} />
      <div
        data-menu="project"
        style={{
          position: 'fixed',
          left: 10,
          top: 106,
          width: 282,
          background: 'var(--proto-card)',
          border: '1px solid var(--proto-line)',
          borderRadius: 12,
          boxShadow: '0 16px 48px rgba(16,24,40,.18)',
          zIndex: 59,
          overflow: 'hidden',
        }}
      >
        {/* header */}
        <div style={{ padding: '11px 13px 10px', borderBottom: '1px solid var(--proto-line-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: 'var(--proto-accent-bg)',
                color: 'var(--proto-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: `600 9.5px ${mono}`,
                flex: 'none',
              }}
            >
              {projInitials}
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{projName}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 11, fontWeight: 700 }}>✓</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 4,
              paddingLeft: 30,
              font: `400 9.5px ${mono}`,
              color: 'var(--proto-muted-3)',
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: 'var(--proto-accent)',
                animation: 'cxpulse 1.6s ease-in-out infinite',
                flex: 'none',
              }}
            />
            <span>{subLabel}</span>
          </div>
          <div
            {...hp('overview')}
            onClick={onOpenOverview}
            style={{
              marginTop: 9,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              border: '1px solid var(--proto-accent-border)',
              background: hover === 'overview' ? 'var(--proto-accent-bg)' : 'var(--proto-accent-bg)',
              borderRadius: 8,
              padding: '6px 0',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)' }}>
              {L.openOverview} →
            </span>
          </div>
        </div>

        {/* SWITCH PROJECT list */}
        <div
          style={{
            padding: '8px 13px 3px',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '.07em',
            color: 'var(--proto-faint)',
          }}
        >
          {L.switchProject}
        </div>
        {/* maxHeight+scroll bounds the popover for real project volume (the prototype's mock had 3
            projects; real ~/.cortex has 20) so "+ New project" stays reachable. Row styling is
            unchanged → visually identical to proto-shot 16 for the visible rows. */}
        <div style={{ padding: '0 6px 6px', maxHeight: 420, overflowY: 'auto' }}>
          {rows.map((row) => {
            const rowKey = 'row:' + row.id;
            return (
              <div
                key={row.id}
                {...hp(rowKey)}
                onClick={() => onSwitch(row.id)}
                data-project-id={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  background: hover === rowKey ? 'var(--proto-gray)' : 'transparent',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: row.isRunning ? 'var(--proto-accent)' : 'var(--proto-line-3)',
                    flex: 'none',
                    ...(row.isRunning
                      ? { animation: 'cxpulse 1.6s ease-in-out infinite' }
                      : {}),
                  }}
                />
                <span
                  style={{
                    font: `${row.unread > 0 ? 600 : 500} 11.5px ${mono}`,
                    color: row.unread > 0 ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
                  }}
                >
                  {row.id}
                </span>
                {/* unread-session count badge (honest addition — sessions.list unread aggregate) */}
                {row.unread > 0 && (
                  <span
                    data-unread-badge={row.id}
                    style={{
                      flex: 'none',
                      minWidth: 14,
                      height: 14,
                      padding: '0 4px',
                      borderRadius: 7,
                      background: 'var(--proto-accent)',
                      color: 'var(--ink-solid-fg)',
                      font: `600 9px ${mono}`,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {row.unread}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', font: `400 9px ${mono}`, color: 'var(--proto-faint)' }}>
                  {row.meta}
                </span>
              </div>
            );
          })}
        </div>

        {/* + New project */}
        <div
          {...hp('newproj')}
          onClick={onNewProject}
          style={{
            borderTop: '1px solid var(--proto-line-2)',
            padding: '9px 13px',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            cursor: 'pointer',
            background: hover === 'newproj' ? 'var(--proto-rail)' : 'transparent',
          }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)' }}>+ {L.newProject}</span>
        </div>
      </div>
    </>
  );
}
