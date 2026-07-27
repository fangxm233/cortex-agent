// input:  running state, formatted status text, optional accessory node
// output: desktop composer status row with right-aligned accessory
// pos:    Presentational status line directly above the composer input
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ReactNode } from 'react';

const MONO = "'IBM Plex Mono',monospace";

export interface ComposerStatusLineProps {
  running: boolean;
  text: string;
  accessory?: ReactNode;
}

export function ComposerStatusLine({ running, text, accessory }: ComposerStatusLineProps): JSX.Element {
  return (
    <div data-composer-status-line="true" style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 11px ${MONO}`, color: running ? 'var(--proto-muted-2)' : 'var(--proto-faint)', padding: '8px 2px 10px' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: running ? 'var(--proto-accent)' : 'var(--proto-line-3)', animation: running ? 'cxpulse 1.6s ease-in-out infinite' : undefined, flex: 'none' }} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
      </span>
      {accessory ? (
        <span data-context-usage-position="composer-status" style={{ marginLeft: 'auto', display: 'inline-flex', flex: 'none' }}>
          {accessory}
        </span>
      ) : null}
    </div>
  );
}
