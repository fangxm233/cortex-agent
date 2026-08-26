// input:  one subagent's identity, complete prompt, and grouped rows
// output: prompt block with a right-aligned tool-call count
// pos:    desktop workbench subagent presentation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useVocab } from '@/i18n';
import { subagentModelLabel } from './transcript-vm';

const mono = "'IBM Plex Mono',monospace";

const typeChipStyle: CSSProperties = {
  font: `600 9px ${mono}`, color: 'var(--proto-muted)',
  background: 'var(--proto-gray)', padding: '1.5px 7px',
  borderRadius: 5, flex: 'none',
};
/** Outlined rather than filled, so the pair reads as one identity at two weights: the type is what
 *  was asked for, the model is merely what served it. Omitted entirely when unknown — an empty slot
 *  would claim we know the model is nothing, and a just-spawned subagent has not answered yet. */
const modelChipStyle: CSSProperties = {
  font: `600 9px ${mono}`, color: 'var(--proto-muted-3)',
  border: '1px solid var(--proto-line-2)', padding: '1.5px 7px',
  borderRadius: 5, flex: 'none',
};
const descStyle: CSSProperties = {
  font: `400 11.5px ${mono}`, color: 'var(--proto-ink-2)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
};
const metaStyle: CSSProperties = {
  font: `400 10.5px ${mono}`, color: 'var(--proto-muted)', flex: 'none', marginLeft: 'auto',
};

/** The dot stands where the disclosure caret used to, so the row leads with state instead of with
 *  chrome. Pulsing accent while the subagent works, `--proto-success` once it is done — the same
 *  green `TaskRow` uses for a finished task. It never unmounts, so a block settling does not shift
 *  the header text sideways. With the caret gone, `aria-expanded` on the header carries the
 *  open/closed state that the triangle used to show. */
function statusDotStyle(running: boolean): CSSProperties {
  return {
    width: 6, height: 6, borderRadius: '50%', flex: 'none',
    background: running ? 'var(--proto-accent)' : 'var(--proto-success)',
    ...(running ? { animation: 'cxpulse 1.6s ease-in-out infinite' } : {}),
  };
}
const bodyStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 16,
  padding: '10px 13px 12px',
  borderTop: '1px solid var(--proto-line-soft)',
};
const promptStyle: CSSProperties = {
  margin: 0, font: `400 11px/1.55 ${mono}`, color: 'var(--proto-ink-2)',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
};
const promptLabelStyle: CSSProperties = {
  font: `600 9px ${mono}`, color: 'var(--proto-muted-3)', marginBottom: 5,
  textTransform: 'uppercase', letterSpacing: '.05em',
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
export function SubagentBlock({ agentType, description, prompt, model, status, toolCount, children }: {
  agentType: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
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
        role="button"
        aria-expanded={expanded}
        style={headerStyle(hover)}
      >
        <span
          style={statusDotStyle(status === 'running')}
          aria-label={status === 'running' ? L.subagentRunning : undefined}
        />
        <span style={typeChipStyle}>{agentType || L.subagentFallbackLabel}</span>
        {model ? <span style={modelChipStyle}>{subagentModelLabel(model)}</span> : null}
        <span style={descStyle}>{label}</span>
        <span style={metaStyle}>{tools}</span>
      </div>
      {expanded ? (
        <div style={bodyStyle}>
          {prompt ? (
            <div>
              <div style={promptLabelStyle}>{L.subagentPromptLabel}</div>
              <pre style={promptStyle}>{prompt}</pre>
            </div>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
