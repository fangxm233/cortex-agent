// 6b 计划全文阅读页 — drill route /m/session/:sessionId/plan/:requestId (from the 6a card's file
// row / the sealed cards' 查看完整计划 ›). Data = the interaction entity found in the REAL
// sessions.transcript (the plan snapshot is persisted on the entity — no separate fetch).
// Approve resolves in place (the page re-renders sealed via the transcript refetch); 驳回并反馈
// routes back to the chat with router state so the composer arms 5a reject mode there.
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { findInteraction, planCardModel } from '@/features/workbench/interaction-vm';
import { useInteractionActions } from '@/features/workbench/useInteractionActions';
import { useSessionMessageLiveSync } from '@/features/workbench/useSessionMessageLiveSync';
import { MC, MONO } from '@/mobile/ui/kit';
import { MPlanReadView, M_PLAN_READ_COPY } from './MPlanReadView';

/** Router state the chat screen reads to arm 5a reject mode on return. */
export interface RejectPlanNavState {
  rejectPlan?: string;
}

export function MPlanReadScreen(): JSX.Element {
  const { sessionId = '', requestId = '' } = useParams<{ sessionId: string; requestId: string }>();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const lang = useLang();
  const copy = pickCopy(lang, M_PLAN_READ_COPY);

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });
  // Live convergence: session.interaction events (this or ANY client resolving) invalidate the
  // transcript, so an approval from Slack/desktop seals this page too.
  useSessionMessageLiveSync(sessionId, undefined);
  const actions = useInteractionActions(sessionId);

  const hit = findInteraction(transcriptQuery.data, requestId);
  const onBack = (): void => navigate(`/m/session/${sessionId}`);

  if (!hit) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: MC.canvas }}>
        <div style={{ font: `400 11px ${MONO}`, color: MC.faint }}>
          {transcriptQuery.isPending ? '…' : lang === 'zh' ? '未找到该计划' : 'Plan not found'}
        </div>
        <button type="button" onClick={onBack} style={{ border: `1px solid ${MC.hairline}`, background: 'var(--proto-card)', borderRadius: 999, padding: '7px 16px', fontSize: 12.5, fontWeight: 600, color: MC.ink, cursor: 'pointer' }}>
          {lang === 'zh' ? '返回会话' : 'Back to chat'}
        </button>
      </div>
    );
  }

  const model = planCardModel(hit.detail, hit.ts);
  return (
    <MPlanReadView
      model={model}
      copy={copy}
      onBack={onBack}
      onApprove={() => {
        if (model.status === 'pending') actions.approvePlan(model.requestId);
      }}
      onReject={() => navigate(`/m/session/${sessionId}`, { state: { rejectPlan: requestId } satisfies RejectPlanNavState })}
    />
  );
}
