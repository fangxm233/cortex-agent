import { mobileHeaderBack } from '@/mobile/mobile-navigation';
// 6b 计划全文阅读页 — drill route /m/session/:sessionId/plan/:requestId (from the 6a card's file
// row / the sealed cards' 查看完整计划 ›). Data = the interaction entity found in the REAL
// sessions.transcript (the plan snapshot is persisted on the entity — no separate fetch).
// Approve resolves in place (the page re-renders sealed via the transcript refetch); 驳回并反馈
// routes back to the chat with router state so the composer arms 5a reject mode there.
import { useNavigate, useParams } from 'react-router-dom';
import { useVocab } from '@/i18n';
import { findInteraction, planCardModel } from '@/features/session/interaction/interaction-vm';
import { useInteractionActions } from '@/features/session/interaction/useInteractionActions';
import { useSessionMessageLiveSync } from '@/features/session/live/useSessionMessageLiveSync';
import { useTranscriptQuery } from '@/features/session/transcript/useTranscriptQuery';
import { MC, MONO } from '@/mobile/ui/kit';
import { MPlanReadView } from './MPlanReadView';

/** Router state the chat screen reads to arm 5a reject mode on return. */
export interface RejectPlanNavState {
  rejectPlan?: string;
}

export function MPlanReadScreen(): JSX.Element {
  const { sessionId = '', requestId = '' } = useParams<{ sessionId: string; requestId: string }>();
  const navigate = useNavigate();
  const L = useVocab();

  const transcriptQuery = useTranscriptQuery(sessionId);
  // Live convergence: session.interaction events (this or ANY client resolving) invalidate the
  // transcript, so an approval from Slack/desktop seals this page too.
  useSessionMessageLiveSync(sessionId, undefined);
  const actions = useInteractionActions(sessionId);

  const hit = findInteraction(transcriptQuery.data, requestId);
  const onBack = (): void => mobileHeaderBack(navigate, `/m/session/${sessionId}`);

  if (!hit) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <div style={{ font: `400 11px ${MONO}`, color: MC.faint }}>
          {transcriptQuery.isPending ? '…' : L.ixPlanNotFound}
        </div>
        <button type="button" onClick={onBack} style={{ border: `1px solid ${MC.hairline}`, background: 'var(--proto-card)', borderRadius: 'var(--r-pill)', padding: '7px 16px', fontSize: 12.5, fontWeight: 600, color: MC.ink, cursor: 'pointer' }}>
          {L.ixBackToChat}
        </button>
      </div>
    );
  }

  const model = planCardModel(hit.detail, hit.ts, L);
  return (
    <MPlanReadView
      model={model}
      onBack={onBack}
      onApprove={() => {
        if (model.status === 'pending') actions.approvePlan(model.requestId);
      }}
      onReject={() => navigate(`/m/session/${sessionId}`, { state: { rejectPlan: requestId } satisfies RejectPlanNavState })}
    />
  );
}
