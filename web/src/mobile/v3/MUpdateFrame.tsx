// input:  mobile update title, summary, description, and action controls
// output: centered mobile alert chrome shared only by mobile update dialogs
// pos:    Mobile-only update frame preserving current DOM and inline visual styles
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties, ReactNode } from 'react';

const MONO = "'IBM Plex Mono', monospace";
const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 60, background: 'var(--overlay-scrim-strong)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 36px',
  boxSizing: 'border-box',
};
const CARD_STYLE: CSSProperties = {
  width: '100%', background: 'var(--proto-card)', borderRadius: 18,
  boxShadow: 'var(--shadow-overlay-strong)', padding: '24px 20px 14px',
  boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center',
};
const ICON_STYLE: CSSProperties = {
  width: 46, height: 46, borderRadius: 14, background: 'var(--proto-accent-bg)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
};
const TITLE_STYLE: CSSProperties = {
  fontSize: 17, fontWeight: 700, color: 'var(--proto-ink)', letterSpacing: '-.01em',
};
const SUMMARY_STYLE: CSSProperties = {
  font: `500 10.5px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 6,
};
const DESCRIPTION_STYLE: CSSProperties = {
  fontSize: 13, lineHeight: 1.6, color: 'var(--proto-muted)', textAlign: 'center',
  margin: '10px 0 18px',
};

export interface MUpdateFrameProps {
  title: string;
  summary: string;
  description: ReactNode;
  children: ReactNode;
}

function MUpdateHeader({ title, summary }: Pick<MUpdateFrameProps, 'title' | 'summary'>) {
  return (
    <>
      <div style={ICON_STYLE}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--proto-accent)" strokeWidth="1.8">
          <path d="M10 14V4M5.5 8.5 10 4l4.5 4.5" />
          <path d="M3.5 16.5h13" />
        </svg>
      </div>
      <div style={TITLE_STYLE}>{title}</div>
      <div style={SUMMARY_STYLE}>{summary}</div>
    </>
  );
}

export function MUpdateFrame(props: MUpdateFrameProps) {
  return (
    <div role="dialog" aria-modal="true" aria-label={props.title} style={OVERLAY_STYLE}>
      <div style={CARD_STYLE}>
        <MUpdateHeader title={props.title} summary={props.summary} />
        <div style={DESCRIPTION_STYLE}>{props.description}</div>
        {props.children}
      </div>
    </div>
  );
}
