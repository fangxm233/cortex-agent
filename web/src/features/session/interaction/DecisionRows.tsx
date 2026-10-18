import { useState, type CSSProperties, type ReactNode } from 'react';
import type { DecisionItem, DecisionActionKind } from '@cortex-agent/ui-contract';
import { fmt, useVocab } from '@/i18n';
import type { Vocab } from '@/i18n';
import { ChatMarkdown } from '@/design/ChatMarkdown';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { messageTimeLabel } from '@/features/session/transcript/transcript-vm';
import { EventIcon, eventRowStyle } from '@/features/session/transcript/EventRow';
import { decisionStatus, buildDecisionMessage, type DecisionStatus } from './decision-vm';
import { useDecisionActions, type DecisionActions } from './useDecisionActions';

// Decisions (send_decision) — choices the agent made on the reader's behalf. Non-blocking by design,
// so each is a record first: one quiet line under the reply that announced it, saying what was
// decided and whether the reader has answered it — a hollow diamond until they have, never a
// "pending" label that would read as a request. Opening the line puts the decision itself first,
// then why, then the context it was made in. Approve only writes the acknowledgement to history
// (nothing reaches the agent); a reply is one box with two ways to send it — ask why (text optional)
// or request a change (text required) — composed from a template that is BOTH recorded on the
// decision and delivered as an ordinary user message.

// ── shared bits ──────────────────────────────────────────────────────────────────────────────────

/** The mark in the line's icon column: hollow until answered, a check once approved, a tinted
 *  diamond while a question or a change request is the latest move. */
function StatusIcon({ status }: { status: DecisionStatus }): JSX.Element {
  if (status === 'approved') return <EventIcon name="check" size={14} color="var(--proto-success)" />;
  if (status === 'explained') return <EventIcon name="diamond" color="var(--proto-accent)" fill="var(--proto-accent-bg)" />;
  if (status === 'revised') return <EventIcon name="diamond" color="var(--proto-warn)" fill="var(--proto-warn-bg)" />;
  return <EventIcon name="diamond" />;
}

function statusWord(status: DecisionStatus, L: Vocab): { text: string; color: string } | null {
  if (status === 'approved') return { text: L.wbDecApproved, color: 'var(--proto-success)' };
  if (status === 'explained') return { text: L.wbDecExplainRequested, color: 'var(--proto-accent)' };
  if (status === 'revised') return { text: L.wbDecReviseProposed, color: 'var(--proto-warn)' };
  return null;
}

function actionLabel(kind: DecisionActionKind, L: Vocab): string {
  return kind === 'approve' ? L.wbDecApproved : kind === 'explain' ? L.wbDecExplainRequested : L.wbDecReviseProposed;
}

const TITLE: CSSProperties = { color: 'var(--proto-ink-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const META: CSSProperties = { paddingLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--proto-faint)' };
const LEAD: CSSProperties = { flex: 'none', fontWeight: 600, color: 'var(--proto-muted)', minWidth: 40 };

function buttonStyle(kind: 'primary' | 'secondary' | 'ghost', touch: boolean, disabled = false): CSSProperties {
  const base: CSSProperties = {
    height: touch ? 40 : 30, padding: '0 12px', borderRadius: 'var(--r-control)', fontFamily: 'inherit',
    fontSize: touch ? 13.5 : 12.5, fontWeight: 550, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: 6, cursor: disabled ? 'not-allowed' : 'pointer', flex: touch ? 1 : 'none', boxSizing: 'border-box',
  };
  if (kind === 'primary') {
    return { ...base, border: '1px solid transparent', background: disabled ? 'var(--proto-gray)' : 'var(--proto-ink)', color: disabled ? 'var(--proto-muted)' : 'var(--ink-solid-fg)' };
  }
  if (kind === 'ghost') return { ...base, border: '1px solid transparent', background: 'transparent', color: 'var(--proto-muted)' };
  return { ...base, border: '1px solid var(--proto-line-3)', background: 'var(--material-control-bg)', color: 'var(--proto-ink)' };
}

/** A small button on the hovered line: approve or reply without opening it. */
function QuickButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={MENU_FOCUS} onClick={onClick}
      style={{ height: 24, padding: '0 9px', borderRadius: 6, border: '1px solid var(--proto-line-3)', background: 'var(--material-control-bg)', fontFamily: 'inherit', fontSize: 12, fontWeight: 550, color: 'var(--proto-ink-2)', cursor: 'pointer', flex: 'none' }}>
      {label}
    </button>
  );
}

/** "Why  …" — a quiet lead-in word and the field's text beside it. */
function Lead({ label, children, ink }: { label: string; children: ReactNode; ink: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, minWidth: 0, color: ink }}>
      <span style={LEAD}>{label}</span>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

// ── the row ──────────────────────────────────────────────────────────────────────────────────────

/** One decision: a line that opens in place into the decision, its reasons and the reply box. */
export function DecisionRow({ d, actions, touch = false }: { d: DecisionItem; actions?: DecisionActions; touch?: boolean }): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const status = decisionStatus(d);
  const approved = status === 'approved';
  const word = statusWord(status, L);
  const last = d.actions[d.actions.length - 1];
  // A phone keeps the line's room for the title; the time is in the log when the line opens.
  const time = last && !touch ? messageTimeLabel(last.ts) : null;
  const busy = !!actions?.busy;
  const templates = { explain: L.wbDecExplainTemplate, explainBare: L.wbDecExplainTemplateBare, revise: L.wbDecReviseTemplate };
  const change = buildDecisionMessage(templates, 'revise', d.title, text);

  const close = (): void => { setOpen(false); setReplying(false); setText(''); };
  const toggle = (): void => { if (open) close(); else setOpen(true); };
  const reply = (): void => { setOpen(true); setReplying(true); };
  const approve = (): void => { if (!busy) actions?.respond(d.id, 'approve'); };
  const send = (kind: 'explain' | 'revise'): void => {
    const message = buildDecisionMessage(templates, kind, d.title, text);
    if (!message || busy) return;
    actions?.respond(d.id, kind, message);
    close();
  };
  // A line someone can still answer offers approve and reply on hover; touch opens the line instead.
  const quick = !!actions && !touch && !open && !approved;

  return (
    <div data-decision={d.id} data-decision-status={status} style={{ minWidth: 0 }}>
      <div className={`group/decision${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`}
        style={{ display: 'flex', alignItems: 'center', margin: '0 -8px', padding: '0 8px', borderRadius: 8, minWidth: 0 }}>
        <button type="button" className={MENU_FOCUS} aria-expanded={open} data-decision-toggle={d.id} onClick={toggle}
          style={{ ...eventRowStyle(touch, true), width: 'auto', flex: 1, margin: 0, padding: 0 }}>
          <span style={{ width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' }}>
            {open ? <EventIcon name="chevron" open /> : <StatusIcon status={status} />}
          </span>
          <span style={{ fontWeight: 550, color: 'var(--proto-ink-3)', flex: 'none' }}>{L.wbDecLabel}</span>
          <span style={TITLE}>{d.title}</span>
          {(word || time) && (
            // The class hides the meta while the quick buttons stand in its place; it sits on a
            // wrapper because an inline `display` would outrank it.
            <span className={quick ? 'group-hover/decision:hidden group-focus-within/decision:hidden' : undefined} style={{ marginLeft: 'auto', flex: 'none' }}>
              <span style={META}>
                {word && <span style={{ color: word.color }}>{word.text}</span>}
                {time}
              </span>
            </span>
          )}
        </button>
        {quick && (
          <span className="hidden group-hover/decision:inline-flex group-focus-within/decision:inline-flex" style={{ gap: 6, paddingLeft: 12, flex: 'none' }}>
            <QuickButton label={`✓ ${L.wbDecApprove}`} onClick={approve} />
            <QuickButton label={L.wbDecReply} onClick={reply} />
          </span>
        )}
      </div>

      {open && (
        <div data-decision-body="" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: touch ? '2px 0 10px 25px' : '2px 0 10px 26px' }}>
          <div style={{ fontSize: touch ? 15 : 14, lineHeight: 1.7, color: 'var(--proto-ink)' }}>
            <ChatMarkdown text={d.decision} />
          </div>
          <div style={{ fontSize: touch ? 14 : 13, lineHeight: 1.7 }}>
            <Lead label={L.wbDecWhy} ink="var(--proto-ink-3)"><ChatMarkdown text={d.reasoning} /></Lead>
          </div>
          <div style={{ fontSize: touch ? 13.5 : 12.5, lineHeight: 1.65 }}>
            <Lead label={L.wbDecContext} ink="var(--proto-muted)"><ChatMarkdown text={d.context} /></Lead>
          </div>

          {d.actions.length > 0 && (
            <div data-decision-log="" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, lineHeight: 1.55, color: 'var(--proto-muted)' }}>
              {d.actions.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, minWidth: 0 }}>
                  <span style={{ flex: 'none', minWidth: 40, color: 'var(--proto-faint)' }}>{messageTimeLabel(a.ts) ?? ''}</span>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <span style={{ fontWeight: 600, color: a.action === 'approve' ? 'var(--proto-success)' : 'var(--proto-ink-3)', marginRight: 6 }}>
                      {a.message ? L.wbDecYou : actionLabel(a.action, L)}
                    </span>
                    {a.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {actions && !replying && (
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              {!approved && (
                <button type="button" className={MENU_FOCUS} disabled={busy} onClick={approve} style={buttonStyle('primary', touch, busy)}>
                  ✓ {L.wbDecApprove}
                </button>
              )}
              <button type="button" className={MENU_FOCUS} onClick={reply} style={buttonStyle('secondary', touch)}>
                {L.wbDecReply}
              </button>
            </div>
          )}

          {actions && replying && (
            <div data-decision-reply="" style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--proto-accent-border)', borderRadius: 'var(--r-card)', background: 'var(--material-control-bg)', padding: '10px 12px' }}>
              <textarea
                className="focus-visible:outline-none"
                aria-label={L.wbDecReply}
                autoFocus
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={L.wbDecReplyPlaceholder}
                style={{ width: '100%', minWidth: 0, resize: touch ? 'none' : 'vertical', border: 0, outline: 'none', background: 'transparent', padding: 0, fontFamily: 'inherit', fontSize: touch ? 16 : 13, lineHeight: 1.6, color: 'var(--proto-ink)', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', flexWrap: touch ? 'nowrap' : 'wrap', alignItems: 'center', gap: 8 }}>
                {!touch && <span style={{ fontSize: 12, color: 'var(--proto-faint)' }}>{L.wbDecReplyHint}</span>}
                {!touch && <span style={{ flex: 1 }} />}
                <button type="button" className={MENU_FOCUS} onClick={() => { setReplying(false); setText(''); }} style={buttonStyle('ghost', touch)}>
                  {L.wbDecCancel}
                </button>
                <button type="button" className={MENU_FOCUS} disabled={busy} onClick={() => send('explain')} style={buttonStyle('secondary', touch, busy)}>
                  {L.wbDecAskWhy}
                </button>
                <button type="button" className={MENU_FOCUS} disabled={busy || !change} onClick={() => send('revise')} style={buttonStyle('primary', touch, busy || !change)}>
                  {L.wbDecRequestChange}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────

/** How many decisions a reply shows before the rest fold into one line. */
export const DECISIONS_SHOWN = 3;

/** Hung under the agent text like the file group: one line per decision, the rest of a long batch
 *  folded into a line that also approves the whole batch at once. */
export function DecisionList({ decisions, sessionId, touch = false }: { decisions: DecisionItem[]; sessionId?: string; touch?: boolean }): JSX.Element {
  const L = useVocab();
  const actions = useDecisionActions(sessionId ?? '');
  const [all, setAll] = useState(false);
  const live = sessionId ? actions : undefined;
  const shown = all ? decisions : decisions.slice(0, DECISIONS_SHOWN);
  const hidden = decisions.length - shown.length;
  const open = decisions.filter((d) => decisionStatus(d) !== 'approved').map((d) => d.id);
  return (
    <div data-decision-list="" style={{ width: '100%', display: 'flex', flexDirection: 'column', marginTop: 8 }}>
      {shown.map((d) => <DecisionRow key={d.id} d={d} actions={live} touch={touch} />)}
      {hidden > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <button type="button" className={`${MENU_FOCUS}${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`} data-decision-more="" onClick={() => setAll(true)}
            style={{ ...eventRowStyle(touch, true), width: 'auto', flex: 1 }}>
            <span style={{ width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' }}>
              <EventIcon name="chevron" />
            </span>
            <span>{fmt(L.wbDecMore, { n: hidden })}</span>
          </button>
          {live?.approveAll && open.length > 1 && (
            <button type="button" className={MENU_FOCUS} disabled={live.busy} onClick={() => live.approveAll!(open)}
              style={{ ...buttonStyle('ghost', touch, live.busy), flex: 'none', color: 'var(--proto-accent)' }}>
              {L.wbDecApproveAll}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
