// input:  decision items, vocab copy, and the respondDecision mutation
// output: Desktop decision cards with expansion-gated response actions
// pos:    Transcript-inline presentation of agent-announced decisions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DecisionItem, DecisionActionKind } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import type { Vocab } from '@/i18n';
import { ChatMarkdown } from './ChatMarkdown';
import { messageTimeLabel } from './transcript-vm';
import { decisionStatus, buildDecisionMessage, type DecisionStatus } from './decision-vm';

const mono = "'IBM Plex Mono',monospace";

// Decision cards (send_decision) — the agent announced choices it made on the user's behalf.
// Non-blocking by design: the card is a record first, an entry point second. Approve only writes
// the acknowledgement to history (nothing reaches the agent); explain/revise compose a templated
// message that is BOTH recorded on the decision and delivered as an ordinary user message.

// ── actions hook (mirror of useInteractionActions: no local card state, refetch settles) ─────────

export interface DecisionActions {
  respond: (decisionId: string, action: DecisionActionKind, message?: string) => void;
  busy: boolean;
}

export function useDecisionActions(sessionId: string): DecisionActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mut = useMutation(trpc.sessions.respondDecision.mutationOptions());

  const refresh = useCallback(() => {
    queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
  }, [queryClient, trpc, sessionId]);

  const respond = useCallback((decisionId: string, action: DecisionActionKind, message?: string) => {
    if (!sessionId || mut.isPending) return;
    mut.mutate(
      { sessionId, decisionId, action, ...(message ? { message } : {}) },
      { onSettled: refresh },
    );
  }, [sessionId, mut, refresh]);

  return { respond, busy: mut.isPending };
}

// ── shared bits ──────────────────────────────────────────────────────────────────────────────────

function statusChip(status: DecisionStatus, L: Vocab): { label: string; fg: string; bg: string } | null {
  if (status === 'approved') return { label: `✓ ${L.wbDecApproved}`, fg: 'var(--proto-success)', bg: 'var(--proto-success-bg)' };
  if (status === 'explained') return { label: L.wbDecExplainRequested, fg: 'var(--proto-accent)', bg: 'var(--proto-accent-bg)' };
  if (status === 'revised') return { label: L.wbDecReviseProposed, fg: 'var(--proto-amber-fg)', bg: 'var(--proto-amber-bg)' };
  return null;
}

function actionLabel(kind: DecisionActionKind, L: Vocab): string {
  return kind === 'approve' ? L.wbDecApproved : kind === 'explain' ? L.wbDecExplainRequested : L.wbDecReviseProposed;
}

function DecBadge({ L }: { L: Vocab }): JSX.Element {
  return (
    <span style={{ font: `700 8px ${mono}`, letterSpacing: '.06em', color: 'var(--proto-accent)', background: 'var(--proto-accent-bg)', border: '1px solid var(--proto-accent-border)', borderRadius: 4, padding: '2px 5px', flex: 'none' }}>
      {L.wbDecBadge}
    </span>
  );
}

function Chip({ chip }: { chip: { label: string; fg: string; bg: string } }): JSX.Element {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2.5px 8px', borderRadius: 999, background: chip.bg, color: chip.fg, flex: 'none', whiteSpace: 'nowrap' }}>
      {chip.label}
    </span>
  );
}

// ── the card ─────────────────────────────────────────────────────────────────────────────────────

type Mode = 'view' | 'explain' | 'revise';

function Section({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <div style={{ marginTop: 13 }}>
      <div style={{ font: `600 10px ${mono}`, letterSpacing: '.05em', color: 'var(--proto-muted-3)', paddingBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--proto-ink-2)' }}>
        <ChatMarkdown text={text} />
      </div>
    </div>
  );
}

/** Disclosure caret — points right when collapsed, down when open. */
function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <span
      style={{ width: 12, height: 12, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .16s ease' }}
    >
      <svg width={7} height={10} viewBox="0 0 7 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M1.5 1 5.5 5l-4 4" />
      </svg>
    </span>
  );
}

/** One decision: a collapsed one-line record that expands in place into the full reasoning and
 *  the response row. Nothing overlays the transcript, so no portal or stacking games are needed. */
export function DecisionCard({ d, actions }: { d: DecisionItem; actions?: DecisionActions }): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [text, setText] = useState('');
  const status = decisionStatus(d);
  const chip = statusChip(status, L);
  const approved = status === 'approved';
  const busy = !!actions?.busy;

  const composed = mode === 'view' ? null : buildDecisionMessage(
    { explain: L.wbDecExplainTemplate, explainBare: L.wbDecExplainTemplateBare, revise: L.wbDecReviseTemplate },
    mode,
    d.title,
    text,
  );
  const canSend = !busy && composed !== null;

  const collapse = (): void => { setOpen(false); setMode('view'); setText(''); };
  const toggle = (): void => { if (open) collapse(); else setOpen(true); };
  /** Switch the expanded card between its response modes. */
  const into = (m: Mode): void => { setOpen(true); setMode(mode === m ? 'view' : m); };

  const approve = (): void => {
    if (busy) return;
    actions?.respond(d.id, 'approve');
  };
  const send = (): void => {
    if (!canSend || mode === 'view') return;
    actions?.respond(d.id, mode, composed!);
    collapse();
  };

  return (
    <div style={{ width: '100%', border: '1px solid var(--proto-line)', background: 'var(--proto-card)', borderRadius: 10, boxShadow: 'var(--shadow-card-subtle)', boxSizing: 'border-box' }}>
      {/* Header toggles disclosure; response actions live only in the expanded body. */}
      <div
        role="button"
        data-decision-toggle={d.id}
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 38, padding: '6px 11px', boxSizing: 'border-box', cursor: 'pointer' }}
      >
        <DecBadge L={L} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
        {chip && <Chip chip={chip} />}
        <Caret open={open} />
      </div>

      {/* body — 背景 → 决策 → 理由, the action log when non-empty, then the response row */}
      {open && (
        <div style={{ borderTop: '1px solid var(--proto-line-2)', padding: '3px 13px 13px' }}>
          <Section label={L.wbDecContext} text={d.context} />
          <Section label={L.wbDecDecision} text={d.decision} />
          <Section label={L.wbDecReasoning} text={d.reasoning} />
          {d.actions.length > 0 && (
            <div style={{ marginTop: 14, border: '1px solid var(--proto-line-2)', background: 'var(--proto-rail)', borderRadius: 10, padding: '10px 13px' }}>
              <div style={{ font: `600 10px ${mono}`, letterSpacing: '.05em', color: 'var(--proto-muted-3)', paddingBottom: 6 }}>{L.wbDecLog}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {d.actions.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, lineHeight: 1.5 }}>
                    <span style={{ font: `400 9.5px ${mono}`, color: 'var(--proto-faint)', flex: 'none' }}>{messageTimeLabel(a.ts) ?? ''}</span>
                    <span style={{ fontWeight: 600, color: a.action === 'approve' ? 'var(--proto-success)' : 'var(--proto-muted-2)', flex: 'none' }}>{actionLabel(a.action, L)}</span>
                    {a.message && <span style={{ color: 'var(--proto-muted)', overflowWrap: 'anywhere', minWidth: 0 }}>{a.message}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {actions && (
            <div style={{ marginTop: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {approved ? (
                  <span style={{ height: 30, borderRadius: 8, background: 'var(--proto-success-bg)', color: 'var(--proto-success)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, padding: '0 14px' }}>
                    ✓ {L.wbDecApproved}
                  </span>
                ) : (
                  <span
                    role="button"
                    onClick={approve}
                    style={{ fontSize: 12, fontWeight: 600, borderRadius: 8, padding: '7px 14px', color: 'var(--ink-solid-fg)', background: busy ? 'var(--proto-faint)' : 'var(--proto-ink)', cursor: busy ? 'not-allowed' : 'pointer', flex: 'none' }}
                  >
                    ✓ {L.wbDecApprove}
                  </span>
                )}
                <span
                  role="button"
                  onClick={() => into('explain')}
                  style={{ fontSize: 12, fontWeight: 600, border: `1px solid ${mode === 'explain' ? 'var(--proto-accent)' : 'var(--proto-line-3)'}`, background: mode === 'explain' ? 'var(--proto-accent-bg)' : 'var(--proto-card)', color: mode === 'explain' ? 'var(--proto-accent)' : 'var(--proto-ink)', padding: '6px 13px', borderRadius: 8, cursor: 'pointer', flex: 'none' }}
                >
                  {L.wbDecExplain}
                </span>
                <span
                  role="button"
                  onClick={() => into('revise')}
                  style={{ fontSize: 12, fontWeight: 600, border: `1px solid ${mode === 'revise' ? 'var(--proto-accent)' : 'var(--proto-line-3)'}`, background: mode === 'revise' ? 'var(--proto-accent-bg)' : 'var(--proto-card)', color: mode === 'revise' ? 'var(--proto-accent)' : 'var(--proto-ink)', padding: '6px 13px', borderRadius: 8, cursor: 'pointer', flex: 'none' }}
                >
                  {L.wbDecRevise}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  role="button"
                  onClick={collapse}
                  style={{ fontSize: 12, fontWeight: 500, color: 'var(--proto-muted-2)', padding: '6px 10px', cursor: 'pointer', flex: 'none' }}
                >
                  {L.wbDecCollapse}
                </span>
              </div>
              {mode !== 'view' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 9, alignItems: 'flex-end' }}>
                  <textarea
                    autoFocus
                    rows={2}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={mode === 'explain' ? L.wbDecExplainPlaceholder : L.wbDecRevisePlaceholder}
                    style={{ flex: 1, minWidth: 0, resize: 'vertical', border: '1px solid var(--proto-accent-border)', borderRadius: 8, padding: '7px 11px', fontSize: 12, lineHeight: 1.5, color: 'var(--proto-ink)', background: 'var(--proto-card)', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                  <span
                    role="button"
                    onClick={send}
                    style={{ fontSize: 12, fontWeight: 600, borderRadius: 8, padding: '7px 16px', color: 'var(--ink-solid-fg)', background: canSend ? 'var(--proto-ink)' : 'var(--proto-faint)', cursor: canSend ? 'pointer' : 'not-allowed', flex: 'none' }}
                  >
                    {L.wbDecSend}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Hung under the agent text like the file group — chat-wide, one card per decision. */
export function DecisionCardGroup({ decisions, sessionId }: { decisions: DecisionItem[]; sessionId?: string }): JSX.Element {
  const actions = useDecisionActions(sessionId ?? '');
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 10 }}>
      {decisions.map((d) => (
        <DecisionCard key={d.id} d={d} actions={sessionId ? actions : undefined} />
      ))}
    </div>
  );
}
