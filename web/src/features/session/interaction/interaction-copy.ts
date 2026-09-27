// Interaction summary words (resolved / expired / cancelled rows) and the untitled-plan fallback.
// Selected by lang so the hook-free interaction-vm can use them on desktop and mobile alike.
import type { Lang } from '@/i18n';

export interface InteractionSummaryCopy {
  plan: string;
  planApproved: string;
  planRejected: string;
  answered: string;
  cancelled: string;
  planExpired: string;
  expired: string;
}

export const INTERACTION_SUMMARY_COPY: Record<Lang, InteractionSummaryCopy> = {
  en: {
    plan: 'Plan',
    planApproved: 'Plan approved',
    planRejected: 'Plan rejected',
    answered: 'Answered',
    cancelled: 'Cancelled',
    planExpired: 'Plan expired',
    expired: 'Expired',
  },
  zh: {
    plan: '计划',
    planApproved: '计划已批准',
    planRejected: '计划已驳回',
    answered: '已回答',
    cancelled: '已取消',
    planExpired: '计划已过期',
    expired: '已过期',
  },
};
