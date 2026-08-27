// input:  decision items, shared decision rules, and the respondDecision hook
// output: Mobile decision cards with a bottom-sheet detail and actions
// pos:    @ds-adherence-ignore Mobile presentation of agent-announced decisions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useState } from 'react';
import type { DecisionItem, DecisionActionKind } from '@cortex-agent/ui-contract';
import { MC, MONO, MBottomSheet } from '@/mobile/ui/kit';
import { useVocab, type Vocab } from '@/i18n';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import { messageTimeLabel } from '@/features/workbench/transcript-vm';
import { useDecisionActions, type DecisionActions } from '@/features/workbench/DecisionCards';
import { decisionStatus, buildDecisionMessage, type DecisionStatus } from '@/features/workbench/decision-vm';

// Mobile twin of the desktop DecisionCards: same vocabulary, same pure rules (decision-vm), same
// mutation hook — only the chrome differs (tap → MBottomSheet instead of hover actions + modal).

function chipOf(status: DecisionStatus, L: Vocab): { label: string; fg: string; bg: string } | null {
  if (status === 'approved') return { label: `✓ ${L.wbDecApproved}`, fg: MC.done, bg: MC.doneBg };
  if (status === 'explained') return { label: L.wbDecExplainRequested, fg: MC.run, bg: MC.runBg };
  if (status === 'revised') return { label: L.wbDecReviseProposed, fg: MC.amberInk, bg: MC.amberBg };
  return null;
}

function actionLabel(kind: DecisionActionKind, L: Vocab): string {
  return kind === 'approve' ? L.wbDecApproved : kind === 'explain' ? L.wbDecExplainRequested : L.wbDecReviseProposed;
}

function Badge({ L }: { L: Vocab }): JSX.Element {
  return (
    <span style={{ font: `700 8px ${MONO}`, letterSpacing: '.06em', color: MC.run, background: MC.runBg, border: `1px solid ${MC.runBorder}`, borderRadius: 4, padding: '2px 5px', flex: 'none' }}>
      {L.wbDecBadge}
    </span>
  );
}

function Section({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <div style={{ marginTop: 13 }}>
      <div style={{ font: `600 10px ${MONO}`, letterSpacing: '.05em', color: MC.faint, paddingBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: MC.body }}>
        <ChatMarkdown text={text} />
      </div>
    </div>
  );
}

type SheetMode = 'view' | 'explain' | 'revise';

function MDecisionSheet({ d, actions, onClose }: { d: DecisionItem; actions?: DecisionActions; onClose: () => void }): JSX.Element {
  const L = useVocab();
  const [mode, setMode] = useState<SheetMode>('view');
  const [text, setText] = useState('');
  const status = decisionStatus(d);
  const chip = chipOf(status, L);
  const busy = !!actions?.busy;

  const composed = mode === 'view' ? null : buildDecisionMessage(
    { explain: L.wbDecExplainTemplate, explainBare: L.wbDecExplainTemplateBare, revise: L.wbDecReviseTemplate },
    mode,
    d.title,
    text,
  );
  const canSend = !busy && composed !== null;

  const send = (): void => {
    if (!canSend || mode === 'view') return;
    actions?.respond(d.id, mode, composed!);
    onClose();
  };
  const approve = (): void => {
    if (busy) return;
    actions?.respond(d.id, 'approve');
    onClose();
  };
  const modeBtn = (m: 'explain' | 'revise', label: string): JSX.Element => (
    <span
      role="button"
      onClick={() => setMode(mode === m ? 'view' : m)}
      style={{ flex: 1, height: 40, borderRadius: 10, border: `1px solid ${mode === m ? MC.run : MC.cardBorder}`, background: mode === m ? MC.runBg : 'var(--proto-card)', color: mode === m ? MC.run : MC.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}
    >
      {label}
    </span>
  );

  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ padding: '2px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge L={L} />
          {chip && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: chip.bg, color: chip.fg, flex: 'none' }}>{chip.label}</span>}
        </div>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em', marginTop: 8, lineHeight: 1.4, overflowWrap: 'break-word' }}>{d.title}</div>

        <div style={{ maxHeight: '46vh', overflow: 'auto', marginTop: 2 }}>
          <Section label={L.wbDecContext} text={d.context} />
          <Section label={L.wbDecDecision} text={d.decision} />
          <Section label={L.wbDecReasoning} text={d.reasoning} />
          {d.actions.length > 0 && (
            <div style={{ marginTop: 14, border: `1px solid ${MC.hairline}`, background: MC.canvas, borderRadius: 10, padding: '9px 12px' }}>
              <div style={{ font: `600 10px ${MONO}`, letterSpacing: '.05em', color: MC.faint, paddingBottom: 5 }}>{L.wbDecLog}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {d.actions.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 12, lineHeight: 1.5 }}>
                    <span style={{ font: `400 9.5px ${MONO}`, color: MC.faint, flex: 'none' }}>{messageTimeLabel(a.ts) ?? ''}</span>
                    <span style={{ fontWeight: 600, color: a.action === 'approve' ? MC.done : MC.sub, flex: 'none' }}>{actionLabel(a.action, L)}</span>
                    {a.message && <span style={{ color: MC.muted, overflowWrap: 'anywhere', minWidth: 0 }}>{a.message}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {actions && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {status === 'approved' ? (
                <span style={{ flex: 1, height: 40, borderRadius: 10, background: MC.doneBg, color: MC.done, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
                  ✓ {L.wbDecApproved}
                </span>
              ) : (
                <span
                  role="button"
                  onClick={approve}
                  style={{ flex: 1, height: 40, borderRadius: 10, background: busy ? MC.faint : MC.ink, color: MC.inkSolidFg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}
                >
                  ✓ {L.wbDecApprove}
                </span>
              )}
              {modeBtn('explain', L.wbDecExplain)}
              {modeBtn('revise', L.wbDecRevise)}
            </div>
            {mode !== 'view' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 9, alignItems: 'flex-end' }}>
                <textarea
                  autoFocus
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={mode === 'explain' ? L.wbDecExplainPlaceholder : L.wbDecRevisePlaceholder}
                  style={{ flex: 1, minWidth: 0, resize: 'none', border: `1px solid ${MC.runBorder}`, borderRadius: 10, padding: '8px 11px', fontSize: 13, lineHeight: 1.5, color: MC.ink, background: 'var(--proto-card)', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <span
                  role="button"
                  onClick={send}
                  style={{ height: 38, borderRadius: 10, padding: '0 16px', background: canSend ? MC.ink : MC.faint, color: MC.inkSolidFg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flex: 'none' }}
                >
                  {L.wbDecSend}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </MBottomSheet>
  );
}

function MDecisionCard({ d, actions }: { d: DecisionItem; actions?: DecisionActions }): JSX.Element {
  const L = useVocab();
  const [open, setOpen] = useState(false);
  const chip = chipOf(decisionStatus(d), L);
  return (
    <>
      <div
        role="button"
        onClick={() => setOpen(true)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${MC.hairline}`, background: 'var(--proto-card)', borderRadius: 12, padding: '9px 11px', boxSizing: 'border-box' }}
      >
        <Badge L={L} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: MC.ink, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
        {chip && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: chip.bg, color: chip.fg, flex: 'none', whiteSpace: 'nowrap' }}>{chip.label}</span>}
        <span style={{ fontSize: 11, color: MC.faint, flex: 'none' }}>›</span>
      </div>
      {open && <MDecisionSheet d={d} actions={actions} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Hung under the agent text, one card per decision (same slot as the attachment group). */
export function MDecisionCardGroup({ decisions, sessionId }: { decisions: DecisionItem[]; sessionId?: string }): JSX.Element {
  const actions = useDecisionActions(sessionId ?? '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {decisions.map((d) => (
        <MDecisionCard key={d.id} d={d} actions={sessionId ? actions : undefined} />
      ))}
    </div>
  );
}
