// input:  one native subagent's grouped rows and its header facts
// output: a collapsible block that keeps a subagent's work out of the main stream
// pos:    desktop workbench subagent presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';

const mono = "'IBM Plex Mono',monospace";

const typeChipStyle: CSSProperties = {
  font: `600 9px ${mono}`, color: 'var(--proto-muted)',
  background: 'var(--proto-gray)', padding: '1.5px 7px',
  borderRadius: 5, flex: 'none',
};
const descStyle: CSSProperties = {
  font: `400 11.5px ${mono}`, color: 'var(--proto-ink-2)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
};
const metaStyle: CSSProperties = {
  font: `400 10.5px ${mono}`, color: 'var(--proto-muted)', flex: 'none',
};

/** Same dot the composer status line uses, so "this is still working" reads identically wherever it
 *  appears. It holds its slot when idle rather than unmounting, so expanding or finishing a block
 *  never shifts the header text sideways. */
function statusDotStyle(running: boolean): CSSProperties {
  return {
    width: 6, height: 6, borderRadius: '50%', flex: 'none',
    background: running ? 'var(--proto-accent)' : 'var(--proto-line-3)',
    ...(running ? { animation: 'cxpulse 1.6s ease-in-out infinite' } : {}),
  };
}
const bodyStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 16,
  padding: '10px 13px 12px',
  borderTop: '1px solid var(--proto-line-soft)',
};

function headerStyle(hover: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5,
    color: hover ? 'var(--proto-muted)' : 'var(--proto-muted-3)',
    padding: '6px 13px', cursor: 'pointer', minWidth: 0,
  };
}

function boxStyle(hover: boolean): CSSProperties {
  return {
    background: 'var(--proto-rail)',
    border: '1px solid ' + (hover ? 'var(--proto-line-3)' : 'var(--proto-line-2)'),
    borderRadius: 8,
  };
}

/**
 * One native subagent's output, folded away by default.
 *
 * The block sits where the spawning `Agent`/`Task` call happened and stands in for that call's
 * chip, so the main stream reads as the main agent's own work. Expanding it renders the subagent's
 * rows with the same renderer the top level uses — the caller passes them in as `children` rather
 * than the block reaching back into the row renderer, which would be a cycle.
 */
export function SubagentBlock({ agentType, description, status, toolCount, children }: {
  agentType: string | null;
  description: string | null;
  status: 'running' | 'done';
  toolCount: number;
  children: ReactNode;
}): JSX.Element {
  const L = useVocab();
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const label = description || agentType || L.subagentFallbackLabel;
  const tools = toolCount === 1 ? `1 ${L.toolCallUnit}` : `${toolCount} ${L.toolCallsUnit}`;
  return (
    <div style={boxStyle(hover)}>
      <div
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={headerStyle(hover)}
      >
        <span style={{ fontSize: 9, color: 'var(--proto-faint)', flex: 'none' }}>{expanded ? '▾' : '▸'}</span>
        <span
          style={statusDotStyle(status === 'running')}
          aria-label={status === 'running' ? L.subagentRunning : undefined}
        />
        <span style={typeChipStyle}>{agentType || L.subagentFallbackLabel}</span>
        <span style={descStyle}>{label}</span>
        <span style={metaStyle}>{tools}</span>
      </div>
      {expanded ? <div style={bodyStyle}>{children}</div> : null}
    </div>
  );
}
