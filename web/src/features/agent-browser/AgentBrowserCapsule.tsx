import { useState, type CSSProperties } from 'react';
import { useDockIntake } from '@/design/dock-intake';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { useVocab, type Vocab } from '@/i18n';
import { ActivityChip, CHIP_TEXT, capsuleStyle, useHeaderCapsuleFit } from '@/features/session/rail/ActivityChip';
import type { AgentBrowserSession } from './agent-browser-api';
import { deviceLabel, pageHost } from './stream-model';

// A session's browser in the chat header: where it runs and what it is doing — starting (Chrome can
// take a while), failed, the page it is on, or held by the person — one click from the live view.

export function AgentBrowserGlyph({ size = 13, color = 'var(--proto-muted)' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5"
      strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" style={{ flex: 'none', display: 'block' }}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6h12M7.5 8.5l2.5 2.5M7.5 8.5v3l1-1" />
    </svg>
  );
}

type CapsuleTone = 'plain' | 'busy' | 'bad' | 'held';

const TONE_COLOR: Record<CapsuleTone, string> = {
  plain: 'var(--proto-muted)',
  busy: 'var(--proto-amber-fg)',
  bad: 'var(--proto-danger)',
  held: 'var(--proto-accent)',
};

export function capsuleSummary(session: AgentBrowserSession, L: Pick<Vocab, 'abCapsule' | 'abStarting' | 'abFailed' | 'abInControl' | 'brServer'>): { parts: string[]; tone: CapsuleTone } {
  const head = [L.abCapsule, deviceLabel(session.device, L)];
  if (session.state === 'starting') return { parts: [...head, L.abStarting], tone: 'busy' };
  if (session.state === 'error') return { parts: [...head, L.abFailed], tone: 'bad' };
  if (session.takenOver) return { parts: [...head, L.abInControl], tone: 'held' };
  const where = pageHost(session.url) ?? session.title ?? null;
  return { parts: where ? [...head, where] : head, tone: 'plain' };
}

const STATUS: CSSProperties = { ...CHIP_TEXT, flex: '0 1 auto' };

/** Desktop header capsule. Folds to its glyph when the header runs short; the words stay in its
 *  tooltip and label. */
export function AgentBrowserCapsule({ session, onOpen }: { session: AgentBrowserSession; onOpen: () => void }): JSX.Element {
  const L = useVocab();
  const compact = useHeaderCapsuleFit().board === 'compact';
  const [hover, setHover] = useState(false);
  const { parts, tone } = capsuleSummary(session, L);
  const label = `${L.abOpen} · ${parts.slice(1).join(' · ')}`;
  return (
    <button type="button" data-agent-browser-capsule={session.sessionId} data-tone={tone} data-compact={compact ? 'true' : undefined}
      className={MENU_FOCUS} onClick={onOpen} aria-label={label} title={label}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...capsuleStyle({ lit: hover }), maxWidth: 280, minWidth: 0, ...(compact ? { padding: '0 10px' } : null) }}>
      <AgentBrowserGlyph color={TONE_COLOR[tone]} />
      {!compact && (
        <span style={{ ...STATUS, color: tone === 'plain' ? undefined : TONE_COLOR[tone] }}>{parts.join(' · ')}</span>
      )}
    </button>
  );
}

/** The header's capsule for a session that holds a browser (`useAgentBrowser`), stepping aside
 *  while the dock already shows that browser. */
export function DockedAgentBrowserCapsule({ session }: { session: AgentBrowserSession }): JSX.Element | null {
  const { canDock, active, activeAgentBrowserSession, openAgentBrowser } = useDockIntake();
  if (!canDock || (active && activeAgentBrowserSession === session.sessionId)) return null;
  return <AgentBrowserCapsule session={session} onOpen={() => openAgentBrowser(session.sessionId)} />;
}

/** Phone: the strip's capsule for a session that holds a browser. It opens the read-only view. */
export function AgentBrowserChip({ session, onOpen }: { session: AgentBrowserSession; onOpen: () => void }): JSX.Element {
  const L = useVocab();
  const { parts, tone } = capsuleSummary(session, L);
  return (
    <ActivityChip data="agent-browser" label={`${L.abOpen} · ${parts.slice(1).join(' · ')}`} floating grow onClick={onOpen}>
      <AgentBrowserGlyph color={TONE_COLOR[tone]} />
      <span style={{ ...CHIP_TEXT, color: tone === 'plain' ? undefined : TONE_COLOR[tone] }}>{parts[0]}{parts[2] ? ` · ${parts[2]}` : ''}</span>
    </ActivityChip>
  );
}
