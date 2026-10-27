import { useState, type CSSProperties, type ReactNode } from 'react';
import { MENU_BUTTON_STYLE, MENU_FOCUS } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { modelLabel } from '@/features/session/composer/model-label';
import { EventIcon, PulseDot } from './EventRow';

const mono = "'IBM Plex Mono',monospace";

const descStyle: CSSProperties = {
  color: 'var(--proto-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
};
const metaStyle: CSSProperties = {
  fontSize: 12, color: 'var(--proto-faint)', flex: 'none', marginLeft: 'auto', paddingLeft: 12, whiteSpace: 'nowrap',
};
/** On a phone the meta takes its own line under the label (icon 16 + gap 9) and truncates rather
 *  than run past the card's edge. */
const touchMetaStyle: CSSProperties = {
  fontSize: 12, color: 'var(--proto-faint)', flex: '1 1 100%', boxSizing: 'border-box', minWidth: 0, paddingLeft: 25,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
/** Paints the card above a pinned header, up to the scroller top, so the body scrolling out above it
 *  does not show through the clearance under the floating title. The open touch card clips it, so
 *  it only shows once the header has moved down inside its own card; it reaches into the header's
 *  rounded corners, under its content, so the pinned header joins it without notches. */
const pinnedCoverStyle: CSSProperties = {
  position: 'absolute', left: 0, right: 0, zIndex: -1, pointerEvents: 'none',
  bottom: 'calc(100% - var(--r-card, 0px))', height: 'calc(var(--transcript-sticky-top, 0px) + var(--r-card, 0px))',
  background: 'var(--proto-card)',
};
const bodyStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
  padding: '8px 14px 12px 34px',
};
const promptStyle: CSSProperties = {
  margin: 0, font: `400 12px/1.6 ${mono}`, color: 'var(--proto-ink-3)',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
};
const promptLabelStyle: CSSProperties = {
  fontSize: 12, fontWeight: 550, color: 'var(--proto-faint)', marginBottom: 4,
};

/** Touch headers grow to a finger-sized target and let the description take its own line on a
 *  phone rather than shrink to a few letters beside the label. */
const TOUCH_HEADER_HEIGHT = 44;

function headerStyle(hover: boolean, expanded: boolean, touch: boolean): CSSProperties {
  return {
    ...MENU_BUTTON_STYLE,
    position: 'sticky', top: 'var(--transcript-sticky-top, 0px)', zIndex: 1,
    display: 'flex', alignItems: 'center', gap: touch ? 9 : 10, fontSize: touch ? 13.5 : 13, lineHeight: 1.45,
    ...(touch ? { flexWrap: 'wrap', minHeight: TOUCH_HEADER_HEIGHT, boxSizing: 'border-box' } : { minHeight: 30 }),
    color: 'var(--proto-muted)',
    // Collapsed, it is one more quiet line on the transcript. Open, it pins over its own scrolling
    // body, so it needs a surface that occludes it at every glass strength, without a filter.
    background: expanded ? 'var(--proto-card)' : hover ? 'var(--proto-gray)' : 'transparent',
    borderRadius: expanded ? 'var(--r-card) var(--r-card) 0 0' : 8,
    padding: expanded ? '6px 14px' : '0 8px', cursor: 'pointer', minWidth: 0,
  };
}

function boxStyle(expanded: boolean, touch: boolean): CSSProperties {
  return expanded
    ? { border: '1px solid var(--proto-line-2)', borderRadius: 'var(--r-card)', background: 'var(--material-inset-bg)',
      ...(touch ? { overflow: 'clip' } : {}) }
    : { margin: '0 -8px' };
}

/**
 * One native subagent's output, folded away by default.
 *
 * The block sits where the spawning `Agent`/`Task` call happened and stands in for that call, so the
 * main stream reads as the main agent's own work. Collapsed it is the transcript's quiet line — the
 * agent type, what it was asked, how many tools it ran; expanding it renders the subagent's rows
 * with the same renderer the top level uses. The caller passes them in as `children` rather than
 * the block reaching back into the row renderer, which would be a cycle.
 */
export function SubagentBlock({ agentType, description, prompt, model, status, toolCount, touch = false, background = false, clean = false, children }: {
  agentType: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  status: 'running' | 'done';
  toolCount: number;
  /** Mobile transcript: finger-sized wrapping header and no hover state. */
  touch?: boolean;
  /** Still running after the turn that started it ended. */
  background?: boolean;
  /** Ran in its own workspace without project context. */
  clean?: boolean;
  children: ReactNode;
}): JSX.Element {
  const L = useVocab();
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const running = status === 'running';
  const label = agentType || L.subagentFallbackLabel;
  const tools = toolCount === 1 ? `1 ${L.toolCallUnit}` : `${toolCount} ${L.toolCallsUnit}`;
  const meta = [clean ? L.chatSubagentClean : null, running && background ? L.chatSubagentRunningBg : null,
    model ? modelLabel(model) : null, tools]
    .filter(Boolean).join(' · ');
  return (
    <div data-subagent-block="" style={boxStyle(expanded, touch)}>
      <button
        type="button"
        className={MENU_FOCUS}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={touch ? undefined : () => setHover(true)}
        onMouseLeave={touch ? undefined : () => setHover(false)}
        role="button"
        aria-expanded={expanded}
        style={headerStyle(hover, expanded, touch)}
      >
        <span style={{ width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' }}
          aria-label={running ? L.subagentRunning : undefined}>
          {running ? <PulseDot /> : <EventIcon name={expanded ? 'chevron' : 'layers'} open={expanded} />}
        </span>
        <span style={{ fontWeight: 550, color: 'var(--proto-ink-3)', flex: 'none' }}>{label}</span>
        {description && description !== label
          ? <span style={touch ? { ...descStyle, flex: '1 1 100px' } : descStyle}>{description}</span>
          : null}
        <span style={touch ? touchMetaStyle : metaStyle}>{meta}</span>
        {touch && expanded ? <span aria-hidden style={pinnedCoverStyle} /> : null}
      </button>
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
