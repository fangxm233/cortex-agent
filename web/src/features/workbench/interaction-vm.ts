// Pure view-model for transcript interaction rows (web-interactions-redesign). Maps the
// server's TranscriptInteractionDetail (a first-class interaction entity with a status
// machine) into one of three render shapes:
//   • ask-pending  → actionable AskQuestionCard
//   • plan-pending → actionable PlanApprovalCard
//   • summary      → one-line resolved/expired/cancelled row (also covers legacy rows)
// The render components own every px/hex; this module only decides which shape exists
// and what text it carries.

import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';
import type { AskQuestionCardData, PlanCardData } from '@/mobile/v3/m-chat-vm';

export interface InteractionRowInput {
  subtype: string;
  text: string;
  detail?: TranscriptInteractionDetail;
}

export type InteractionView =
  | { kind: 'ask-pending'; requestId: string; card: AskQuestionCardData; questions: { question: string }[] }
  | { kind: 'plan-pending'; requestId: string; card: PlanCardData }
  | { kind: 'summary'; tone: 'done' | 'rejected' | 'inactive'; label: string; text: string };

export function mapAskUserToCard(requestId: string, questions: NonNullable<TranscriptInteractionDetail['payload']['questions']>): AskQuestionCardData | null {
  if (!questions.length) return null;
  const firstQ = questions[0];
  return {
    id: requestId.slice(0, 8),
    question: firstQ.question,
    ttlLabel: null,
    options: (firstQ.options ?? []).map((o, i) => ({
      id: String(i),
      label: o.label,
      isDefault: i === 0,
      meta: o.description,
    })),
    source: '',
  };
}

export function mapPlanToCard(planContent: string, planFilePath?: string | null): PlanCardData {
  const lines = planContent.split('\n').filter(Boolean);
  return {
    title: lines[0] || 'Plan',
    estimateLabel: null,
    steps: lines.slice(1, 6).map((text, i) => ({ n: i + 1, text })),
    writePath: planFilePath ?? undefined,
  };
}

function summaryLabel(status: string, kind: string): { tone: 'done' | 'rejected' | 'inactive'; label: string } {
  switch (status) {
    case 'approved': return { tone: 'done', label: 'Plan approved' };
    case 'rejected': return { tone: 'rejected', label: 'Plan rejected' };
    case 'answered': return { tone: 'done', label: 'Answered' };
    case 'cancelled': return { tone: 'inactive', label: 'Cancelled' };
    default: return { tone: 'inactive', label: kind === 'plan-approval' ? 'Plan expired' : 'Expired' };
  }
}

/** Legacy rows (no detail): keep the old subtype-driven summary rendering. */
function legacyView(row: InteractionRowInput): InteractionView {
  const tone = row.subtype === 'plan-rejected' ? 'rejected' : 'done';
  const label = row.subtype === 'plan-approved' ? 'Plan approved' : row.subtype === 'plan-rejected' ? 'Plan rejected' : 'Answered';
  return { kind: 'summary', tone, label, text: row.text };
}

export function interactionView(row: InteractionRowInput): InteractionView {
  const d = row.detail;
  if (!d) return legacyView(row);

  if (d.status === 'pending') {
    if (d.kind === 'ask-user') {
      const questions = d.payload.questions ?? [];
      const card = mapAskUserToCard(d.id, questions);
      if (card) return { kind: 'ask-pending', requestId: d.id, card, questions: questions.map((q) => ({ question: q.question })) };
      return { kind: 'summary', tone: 'inactive', label: 'Expired', text: row.text };
    }
    return { kind: 'plan-pending', requestId: d.id, card: mapPlanToCard(d.payload.planContent ?? '', d.payload.planFilePath) };
  }

  const { tone, label } = summaryLabel(d.status, d.kind);
  return { kind: 'summary', tone, label, text: row.text };
}
