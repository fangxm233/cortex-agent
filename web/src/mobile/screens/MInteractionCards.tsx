import { useState, type CSSProperties, type ReactNode } from 'react';
import { fmt, type Vocab } from '@/i18n';
import { MC, M_NUM } from '@/mobile/ui/kit';
import {
  type AskCardModel,
  type PlanCardModel,
  type AskAnswerState,
  currentQuestionIndex,
  formatTtl,
} from '@/features/session/interaction/interaction-vm';
import { useTtlSeconds } from '@/features/session/interaction/useInteractionTtl';
import { noticeTone } from '@/features/session/transcript/ChatNotice';

// ── shared chrome bits ─────────────────────────────────────────────────────────
// A pending interaction is one of the few things in the stream the user must act on, so it stays a
// card: a neutral ring and a soft lift, a label row that says what it waits for (amber — it waits on
// you), the title, then the actions — a hairline secondary and the ink primary.

function Pill({ bg, fg, text }: { bg: string; fg: string; text: string }): JSX.Element {
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--r-pill)', background: bg, color: fg, flex: 'none' }}>{text}</span>
  );
}

function cardShell(dimmed: boolean, rejected: boolean): CSSProperties {
  return {
    background: 'var(--material-card-bg)',
    boxShadow: '0 0 0 1px var(--proto-line), var(--material-card-shadow)',
    borderRadius: 'var(--r-float)',
    overflow: 'hidden',
    color: rejected ? MC.sub : MC.ink,
    overflowWrap: 'anywhere',
    // Only the active reject-composer mode dims; sealed history stays readable.
    ...(dimmed ? { opacity: 0.55 } : {}),
  };
}

/** The label row atop a pending card: glyph · what it waits for · (its id) · time or TTL at the right. */
function LabelRow({ icon, color, text, id, meta }: {
  icon: ReactNode; color: string; text: string; id?: string | null; meta?: ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, color }}>
      {icon}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...M_NUM }}>{text}</span>
      {id && <span style={{ flex: 'none', font: '400 11.5px var(--font-code)', color: MC.muted }}>{id}</span>}
      {meta != null && <span style={{ marginLeft: 'auto', flex: 'none', fontWeight: 400, ...M_NUM }}>{meta}</span>}
    </div>
  );
}

function PlanGlyph({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M3 2.5h7l3 3v8H3z" />
      <path d="M5.5 8h5M5.5 10.5h3" />
    </svg>
  );
}

function AskGlyph({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.4a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" />
      <path d="M8 11.4v.1" />
    </svg>
  );
}

function FileGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', color: MC.muted }}>
      <path d="M4 2.5h5l3 3v8H4z" />
    </svg>
  );
}

const ACTION_BASE: CSSProperties = {
  flex: 1, height: 44, borderRadius: 'var(--r-control)', boxSizing: 'border-box', cursor: 'pointer',
  fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600,
};
/** The hairline secondary. */
const SECONDARY_ACTION: CSSProperties = {
  ...ACTION_BASE, border: '1px solid var(--proto-line-3)', background: 'var(--material-control-bg)', color: MC.ink,
};
/** The ink primary — the one decision the card asks for. */
const PRIMARY_ACTION: CSSProperties = {
  ...ACTION_BASE, border: 'none', background: MC.inkSolid, color: MC.inkSolidFg,
};

const OPTION_BASE: CSSProperties = {
  minHeight: 44, border: '1px solid var(--proto-line-3)', borderRadius: 'var(--r-control)', display: 'flex',
  alignItems: 'center', gap: 8, padding: '8px 13px', boxSizing: 'border-box', background: 'var(--material-control-bg)',
  cursor: 'pointer', textAlign: 'left', width: '100%', fontFamily: 'var(--font-ui)',
};

const QUIET_TAG: CSSProperties = {
  fontSize: 12, fontWeight: 500, color: MC.muted, background: 'var(--proto-gray)', padding: '1px 7px', borderRadius: 6, flex: 'none',
};

/** The plan file's basename — the plan is read by its name; the full path rides the tooltip and the
 *  read screen. */
function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

// ── MAskCard — 5b 多问题逐问推进 + 4a 封存 ─────────────────────────────────────

export interface MAskCardProps {
  model: AskCardModel;
  /** Session-local progressive answers (the entity resolves once, at the end). */
  state: AskAnswerState;
  copy: Vocab;
  /** Tap an option of the CURRENT single-select question (commits + advances / submits). */
  onPick: (label: string) => void;
  /** Toggle a label of the CURRENT multi-select question. */
  onToggle: (label: string) => void;
  /** Commit the multi-select set of the CURRENT question. */
  onConfirmMulti: () => void;
}

export function MAskCard({ model, state, copy, onPick, onToggle, onConfirmMulti }: MAskCardProps): JSX.Element {
  const pending = model.status === 'pending';
  const cur = currentQuestionIndex(model, state);
  const total = model.questions.length;
  const ttlSec = useTtlSeconds(model.ts, pending);
  // Sealed card (4a): tap to expand the full per-question options for review (不可撤销).
  const [expanded, setExpanded] = useState(false);

  const answerOf = (q: AskCardModel['questions'][number]): string | null => q.answer ?? state.answers[q.question] ?? null;

  // An explicit card level reuses the shared ChatNotice tone on the label row; otherwise the row is
  // amber, like everything else that waits on the user.
  const tone = model.level ? noticeTone(model.level) : null;
  const labelColor = tone ? tone.fg : 'var(--proto-amber-fg)';
  const meta = pending && ttlSec != null
    ? <span style={{ color: MC.amberText }}>{formatTtl(ttlSec)} {copy.ixTtlSuffix}</span>
    : model.timeLabel ? <span style={{ color: MC.muted }}>{model.timeLabel}</span> : null;

  return (
    <div
      {...(model.level ? { 'data-ask-level': model.level } : {})}
      style={cardShell(false, false)}
      onClick={pending ? undefined : () => setExpanded((e) => !e)}
    >
      {/* header */}
      <div style={{ padding: '14px 16px 0' }}>
        {pending ? (
          <LabelRow icon={<AskGlyph color={tone ? tone.fg : 'var(--proto-amber)'} />} color={labelColor}
            text={total > 1 ? `${copy.ixAgentQuestion} · ${Math.min(cur + 1, total)}/${total}` : copy.ixAgentQuestion}
            id={model.shortId} meta={meta} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7 }}>
            <Pill bg={MC.doneBg} fg={MC.done} text={copy.ixAnsweredCheck} />
            {model.shortId && <span style={{ font: '400 11.5px var(--font-code)', color: MC.muted }}>{model.shortId}</span>}
            {meta && <span style={{ marginLeft: 'auto', fontSize: 12, ...M_NUM }}>{meta}</span>}
          </div>
        )}
      </div>

      {/* questions */}
      {model.questions.map((q, i) => {
        const a = answerOf(q);
        const isCurrent = pending && i === cur;
        const isQueued = pending && i > cur;
        const last = i === total - 1;

        // answered — sealed green row (scheme 5b L242-244 / 4a L297-299)
        if (a != null && !isCurrent) {
          return (
            <div key={q.question} style={{ padding: `10px 16px ${last ? '16px' : '0'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--proto-alt)', borderRadius: 'var(--r-control)', padding: '9px 13px' }}>
                <span style={{ width: 16, height: 16, borderRadius: '50%', background: MC.done, color: 'var(--ink-solid-fg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, flex: 'none' }}>✓</span>
                <span style={{ fontSize: 13, color: MC.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {q.question} → <b style={{ color: MC.ink }}>{a}</b>
                </span>
              </div>
              {/* sealed expand — read-only options review */}
              {!pending && expanded && q.options.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0 0' }}>
                  {q.options.map((o) => (
                    <div key={o.label} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--proto-line-2)', background: a.includes(o.label) ? 'var(--proto-gray)' : undefined, borderRadius: 'var(--r-chip)', padding: '6px 11px' }}>
                      <span style={{ fontSize: 12.5, color: a.includes(o.label) ? MC.ink : MC.muted }}>{o.label}</span>
                      {a.includes(o.label) && <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: MC.done }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }

        // current — expanded options (scheme 5b L245-252)
        if (isCurrent) {
          return (
            <div key={q.question} style={{ padding: `10px 16px ${last ? '16px' : '0'}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 650, color: MC.muted, flex: 'none', ...M_NUM }}>Q{i + 1}</span>
                <span style={{ fontSize: 17, fontWeight: 650, color: MC.ink, lineHeight: 1.4, minWidth: 0, overflowWrap: 'anywhere' }}>{q.question}</span>
                {q.multiSelect && <span style={QUIET_TAG}>{copy.ixMulti}</span>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0 0' }}>
                {q.options.map((o, oi) => {
                  const selected = q.multiSelect && state.selected.includes(o.label);
                  const isDefault = !q.multiSelect && oi === 0;
                  return (
                    <button
                      key={o.label}
                      type="button"
                      aria-pressed={q.multiSelect ? selected : undefined}
                      onClick={() => (q.multiSelect ? onToggle(o.label) : onPick(o.label))}
                      style={{
                        ...OPTION_BASE,
                        // A picked option takes the gray selection tint with an ink edge — no accent.
                        ...(selected ? { background: 'var(--proto-gray)', borderColor: MC.ink } : {}),
                      }}
                    >
                      {q.multiSelect && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: selected ? MC.ink : MC.muted, flex: 'none' }}>{selected ? '☑' : '☐'}</span>
                      )}
                      <span style={{ fontSize: 14.5, fontWeight: 550, color: MC.ink, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{o.label}</span>
                      {isDefault ? (
                        <span style={{ ...QUIET_TAG, marginLeft: 'auto' }}>{copy.ixDefaultBadge}</span>
                      ) : o.description ? (
                        <span style={{ marginLeft: 'auto', minWidth: 0, maxWidth: '55%', fontSize: 12.5, color: MC.muted, flex: '0 1 auto', textAlign: 'right', lineHeight: 1.35, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{o.description}</span>
                      ) : null}
                    </button>
                  );
                })}
                {/* 自定义… — free-text via the composer (scheme 5b L250) */}
                <button type="button" style={OPTION_BASE}>
                  <span style={{ fontSize: 14.5, fontWeight: 550, color: MC.sub }}>{copy.ixCustomOption}</span>
                </button>
                {/* multi-select commit (13b semantics carried into the 5b skeleton — the mobile
                    scheme draws only single-select; flagged isomorphic completion) */}
                {q.multiSelect && (
                  <button
                    type="button"
                    onClick={onConfirmMulti}
                    disabled={state.selected.length === 0}
                    style={{ ...PRIMARY_ACTION, flex: 'none', width: '100%', opacity: state.selected.length === 0 ? 0.45 : 1 }}
                  >
                    {copy.ixConfirm}
                  </button>
                )}
              </div>
            </div>
          );
        }

        // queued — dimmed dashed row (scheme 5b L253-255)
        if (isQueued) {
          return (
            <div key={q.question} style={{ padding: `10px 16px ${last ? '16px' : '0'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px dashed var(--proto-line-3)', borderRadius: 'var(--r-control)', padding: '9px 13px' }}>
                <span style={{ fontSize: 12.5, fontWeight: 650, color: MC.muted, flex: 'none', ...M_NUM }}>Q{i + 1}</span>
                <span style={{ fontSize: 13, color: MC.grayInk, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.question}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: MC.muted, flex: 'none' }}>{copy.ixQueued}</span>
              </div>
            </div>
          );
        }

        // pending question with no local answer on a sealed card (shouldn't happen) — skip
        return null;
      })}

    </div>
  );
}

// ── MPlanCard — 6a 薄卡 + 5a 压暗 + 4b/4c 封存 ────────────────────────────────

export interface MPlanCardProps {
  model: PlanCardModel;
  copy: Vocab;
  /** 5a rejecting mode — the card dims and its actions collapse while the composer takes over. */
  dimmed?: boolean;
  onApprove: () => void;
  onRejectStart: () => void;
  onOpenRead: () => void;
}

/** The plan file as a row: its name in the UI face and the read link — the card's main entry. */
function PlanFileRow({ model, copy, link, onOpenRead }: {
  model: PlanCardModel;
  copy: Vocab;
  link: string;
  onOpenRead: () => void;
}): JSX.Element {
  return (
    <div
      role="button"
      data-plan-file-row=""
      title={model.filePath ?? undefined}
      onClick={onOpenRead}
      style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 'var(--r-control)', background: 'var(--proto-rail)', boxSizing: 'border-box', cursor: 'pointer', fontSize: 14, color: 'var(--proto-ink-3)' }}
    >
      <FileGlyph />
      <span style={{ minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...M_NUM }}>
        {model.filePath ? baseName(model.filePath) : fmt(copy.cmLines, { n: model.lineCount })}
      </span>
      <span style={{ flex: 'none', color: 'var(--proto-accent)', fontWeight: 550 }}>{link}</span>
    </div>
  );
}

export function MPlanCard({ model, copy, dimmed = false, onApprove, onRejectStart, onOpenRead }: MPlanCardProps): JSX.Element {
  const pending = model.status === 'pending';
  const rejected = model.status === 'rejected';
  const approved = model.status === 'approved';

  const time = model.timeLabel ? <span style={{ color: MC.faint }}>{model.timeLabel}</span> : undefined;
  const label = <LabelRow icon={<PlanGlyph color="var(--proto-amber)" />} color="var(--proto-amber-fg)" text={copy.mPlanAwaiting} meta={time} />;

  const title = (
    <div
      style={{
        fontSize: pending && !dimmed ? 17 : 15,
        fontWeight: 650,
        color: approved ? MC.sub : rejected ? MC.grayInk : MC.ink,
        lineHeight: 1.4,
        margin: '8px 0 10px',
        overflowWrap: 'break-word' as const,
        ...(rejected ? { textDecoration: 'line-through', textDecorationColor: 'var(--proto-line)' } : {}),
      }}
    >
      {model.title}
    </div>
  );

  // 5a rejecting — dimmed card: label + title + file row, no buttons (scheme L192-198)
  if (pending && dimmed) {
    return (
      <div style={cardShell(true, false)}>
        <div style={{ padding: '14px 16px 16px' }}>
          {label}
          {title}
          <PlanFileRow model={model} copy={copy} link={copy.ixViewFullPlan} onOpenRead={onOpenRead} />
        </div>
      </div>
    );
  }

  // 6a pending — the approval card: the file row is the main entry (scheme L99-119)
  if (pending) {
    return (
      <div style={cardShell(false, false)}>
        <div style={{ padding: '14px 16px 16px' }}>
          {label}
          {title}
          <PlanFileRow model={model} copy={copy} link={copy.mPlanReadFull} onOpenRead={onOpenRead} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button type="button" onClick={onRejectStart} style={SECONDARY_ACTION}>{copy.ixRejectNote}</button>
            <button type="button" onClick={onApprove} style={PRIMARY_ACTION}>{copy.ixApprovePlan}</button>
          </div>
        </div>
      </div>
    );
  }

  // 4b approved / 4c rejected — sealed in place
  return (
    <>
      <div style={cardShell(false, rejected)}>
        <div style={{ padding: '12px 16px 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7 }}>
            {approved
              ? <Pill bg={MC.doneBg} fg={MC.done} text={copy.ixPlanApprovedPill} />
              : <Pill bg={MC.gray} fg={MC.grayInk} text={rejected ? copy.ixPlanRejectedPill : copy.ixPlanPending} />}
            {model.timeLabel && (
              <span style={{ marginLeft: 'auto', fontSize: 12, color: MC.muted, ...M_NUM }}>
                {model.timeLabel}{approved ? ` ${copy.ixApprovedBy}` : ''}
              </span>
            )}
          </div>
          {title}
        </div>
        <div style={{ padding: '0 16px 14px' }}>
          <PlanFileRow model={model} copy={copy} link={rejected ? copy.ixViewOriginalPlan : copy.ixViewFullPlan} onOpenRead={onOpenRead} />
        </div>
      </div>
      {/* 4c — the reject feedback enters the stream as the user bubble (real result.feedback) */}
      {rejected && model.feedback && (
        <div style={{ alignSelf: 'flex-end', maxWidth: '82%', background: MC.inkSolid, color: 'var(--ink-solid-fg)', borderRadius: 'var(--r-float) var(--r-float) 4px var(--r-float)', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          {model.feedback}
        </div>
      )}
    </>
  );
}
