import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';
import { fmt, useVocab } from '@/i18n';
import type { InteractionActions } from '@/features/session/interaction/useInteractionActions';
import {
  askCardModel, askComplete, commitAnswer, confirmSelected, currentQuestionIndex, emptyAskAnswers,
  mergedAnswers, planCardModel, toggleSelected,
  type AskAnswerState, type AskCardModel,
} from '@/features/session/interaction/interaction-vm';
import type { ChatRow } from '@/features/session/transcript/transcript-vm';
import type { RejectPlanNavState } from './MPlanReadScreen';
import type { MChatInteractions, MRejectBar } from './MChatView';
import { interactionHeaderStatus, type ChatHeaderStatus } from './m-chat-vm';

/** The pending interaction that takes over the composer. A non-blocking ask never does: the agent
 *  is still working and the user must stay free to type anything; its card stays tappable inline. */
function pendingInteractionOf(rows: ChatRow[]): { detail: TranscriptInteractionDetail; ts: string | null } | null {
  for (const r of rows) {
    if (r.kind !== 'interaction' || r.detail?.status !== 'pending') continue;
    if (r.detail.kind === 'ask-user' && r.detail.payload.blocking === false) continue;
    return { detail: r.detail, ts: r.ts ?? null };
  }
  return null;
}

/** Session-local progressive answers per ask card: one question at a time, the entity resolving
 *  once the LAST question is answered. */
function useAskAnswers(actions: InteractionActions) {
  const [states, setStates] = useState<Record<string, AskAnswerState>>({});
  const stateOf = (id: string): AskAnswerState => states[id] ?? emptyAskAnswers;
  const commit = (model: AskCardModel, next: AskAnswerState): void => {
    setStates((prev) => ({ ...prev, [model.requestId]: next }));
    if (askComplete(model, next)) actions.answerQuestion(model.requestId, mergedAnswers(model, next));
  };
  const answerCurrent = (model: AskCardModel, label: string): void => {
    const st = stateOf(model.requestId);
    const q = model.questions[currentQuestionIndex(model, st)];
    if (q) commit(model, commitAnswer(st, q.question, label));
  };
  return {
    stateOf,
    answerCurrent,
    toggle: (model: AskCardModel, label: string) => {
      setStates((prev) => ({ ...prev, [model.requestId]: toggleSelected(stateOf(model.requestId), label) }));
    },
    confirmMulti: (model: AskCardModel) => {
      const st = stateOf(model.requestId);
      const q = model.questions[currentQuestionIndex(model, st)];
      if (q && st.selected.length > 0) commit(model, confirmSelected(st, q.question));
    },
  };
}

/** Reject mode — armed by the card's reject button or by the reading page's router state, and
 *  disarmed when the plan resolves elsewhere (Slack / desktop / timeout). */
function useRejectMode(pendingPlanId: string | null) {
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const st = location.state as RejectPlanNavState | null;
    if (st?.rejectPlan) {
      setRejectingId(st.rejectPlan);
      navigate(location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  useEffect(() => {
    if (rejectingId && rejectingId !== pendingPlanId) setRejectingId(null);
  }, [rejectingId, pendingPlanId]);
  return { rejectingId, setRejectingId };
}

export interface MobileInteractionRouting {
  interactions: MChatInteractions;
  /** Plan reject feedback owns the composer (unless an edit does). */
  rejectArmed: boolean;
  rejectBar: MRejectBar | undefined;
  /** A blocking ask owns the composer: typed text answers its current question. */
  answering: boolean;
  /** The header line while an interaction blocks the agent; null otherwise. */
  headerStatus: ChatHeaderStatus | null;
  placeholder: string | undefined;
  disarmReject: () => void;
  /** Route typed text to the interaction that owns the composer. Returns false when none does. */
  submit: (text: string) => boolean;
}

/**
 * The mobile composer doubles as the answer box: plan reject feedback and free-text answers to an
 * ask card go through it, ahead of an ordinary send.
 */
export function useMobileInteractions(input: {
  rows: ChatRow[];
  sessionId: string;
  actions: InteractionActions;
  editing: boolean;
  setText: Dispatch<SetStateAction<string>>;
}): MobileInteractionRouting {
  const L = useVocab();
  const navigate = useNavigate();
  const pending = useMemo(() => pendingInteractionOf(input.rows), [input.rows]);
  const askModel = pending?.detail.kind === 'ask-user' ? askCardModel(pending.detail, pending.ts) : null;
  const planModel = pending?.detail.kind === 'plan-approval' ? planCardModel(pending.detail, pending.ts, L) : null;
  const ask = useAskAnswers(input.actions);
  const { rejectingId, setRejectingId } = useRejectMode(planModel?.requestId ?? null);
  const rejectArmed = !input.editing && !!rejectingId && rejectingId === planModel?.requestId;
  const askIndex = askModel ? currentQuestionIndex(askModel, ask.stateOf(askModel.requestId)) : 0;

  const submit = (text: string): boolean => {
    if (rejectArmed) {
      input.actions.rejectPlan(rejectingId!, text);
      setRejectingId(null);
    } else if (askModel) {
      ask.answerCurrent(askModel, text);
    } else {
      return false;
    }
    input.setText('');
    return true;
  };

  return {
    interactions: {
      askState: ask.stateOf,
      onAskPick: ask.answerCurrent,
      onAskToggle: ask.toggle,
      onAskConfirmMulti: ask.confirmMulti,
      rejectingId: rejectArmed ? rejectingId : null,
      onApprove: (m) => input.actions.approvePlan(m.requestId),
      onRejectStart: (m) => setRejectingId(m.requestId),
      onOpenRead: (m) => navigate(`/m/session/${input.sessionId}/plan/${m.requestId}`),
      onCancelResume: input.actions.cancelResume,
      resumeCancelled: input.actions.resumeCancelled,
    },
    rejectArmed,
    rejectBar: rejectArmed && planModel ? {
      title: fmt(L.chatRejectTitle, { title: planModel.title }),
      chips: [L.chatRejectChipScope, L.chatRejectChipDryRun, L.chatRejectChipBudget, L.chatRejectChipOrder],
      onChipTap: (chip) => input.setText((t) => (t ? `${t}${L.chatRejectChipJoin}${chip}` : chip)),
      onCancel: () => setRejectingId(null),
    } : undefined,
    answering: !!askModel,
    headerStatus: pending
      ? interactionHeaderStatus(pending.detail.kind, askIndex, askModel?.questions.length ?? 1, L)
      : null,
    placeholder: rejectArmed
      ? L.chatRejectPh
      : askModel ? fmt(L.chatAskPh, { n: Math.min(askIndex + 1, askModel.questions.length) }) : undefined,
    disarmReject: () => setRejectingId(null),
    submit,
  };
}
