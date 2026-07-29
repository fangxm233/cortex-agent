// input:  ./types.js (RichBlock/ModalDefinition/ActionElement)
// output: Question types, ask-level helpers, buildQuestion*/buildPlan*
// pos:    Platform-independent interactive component builder
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { RichBlock, ModalDefinition, ActionElement } from './types.js';
import type { ChatNoticeLevel } from '../core/types/agent-types.js';
import { Icons } from '../core/icons.js';
import { t } from '../core/i18n.js';

// --- Ask severity level (shared by webhook, MCP tool, and block builders) ---

/** Normalize a caller-supplied level ('warn' alias accepted) to a ChatNoticeLevel, or null if invalid. */
export function normalizeAskLevel(value: unknown): ChatNoticeLevel | null {
  if (value === 'warn') return 'warning';
  return value === 'info' || value === 'warning' || value === 'error' ? value : null;
}

const LEVEL_ICONS: Record<ChatNoticeLevel, string> = {
  info: Icons.info,
  warning: Icons.warning,
  error: Icons.error,
};

/** Icon for an explicit ask level; '' when the level is absent (legacy neutral look). */
export function askLevelIcon(level: ChatNoticeLevel | null | undefined): string {
  return level ? LEVEL_ICONS[level] : '';
}

// --- Question group types ---

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionRecord {
  pendingId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionGroup {
  groupId: string;
  questions: QuestionRecord[];
  answers: Map<string, { header: string; value: string | string[] }>;
  /** Optional severity of the whole card — explicit levels render a banner/icon prefix. */
  level?: ChatNoticeLevel | null;
}

// --- AskUserQuestion builders ---

export function buildQuestionGroupBlocks(group: QuestionGroup): RichBlock[] {
  const blocks: RichBlock[] = [];
  const levelIcon = askLevelIcon(group.level);
  if (levelIcon) blocks.push({ type: 'context', text: `${levelIcon} ${group.level}` });
  const allAnswered = group.answers.size === group.questions.length;
  for (const [qIdx, q] of group.questions.entries()) {
    if (qIdx > 0) blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: `*${q.header}*\n${q.question}` });
    const answer = group.answers.get(q.pendingId);
    if (answer) {
      const formatted = Array.isArray(answer.value) ? `[${answer.value.join(', ')}]` : answer.value;
      blocks.push({ type: 'context', text: `${Icons.ok} ${formatted}` });
    } else {
      const optionsList = q.options.map(o => o.label).join(' · ');
      blocks.push({ type: 'context', text: `_${optionsList}_` });
    }
  }
  if (!allAnswered) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button' as const,
        text: t('modal.answer', { answered: group.answers.size, total: group.questions.length }),
        actionId: 'ask_user_question_open_modal',
        value: group.groupId,
        style: 'primary' as const,
      }],
    });
  }
  return blocks;
}

export function buildQuestionModalDefinition(group: QuestionGroup): ModalDefinition {
  const fields: ModalDefinition['fields'] = [];
  for (const [qIdx, q] of group.questions.entries()) {
    let questionText = `*${q.header}*\n${q.question}`;
    if (q.options.some(o => o.description)) {
      for (const option of q.options) {
        if (option.description) questionText += `\n• *${option.label}*: ${option.description}`;
      }
    }
    fields.push({ type: 'section', text: questionText });
    // Only add select field when there are options — Slack rejects empty option lists.
    if (q.options.length > 0) {
      fields.push({
        type: q.multiSelect ? 'multi_select' : 'select',
        blockId: `q_${qIdx}`,
        label: q.multiSelect ? t('modal.selectOneOrMore') : t('modal.selectOne'),
        actionId: 'selection',
        placeholder: q.multiSelect ? t('modal.selectOneOrMore') : t('modal.selectOne'),
        options: q.options.map((option, optIdx) => ({
          label: option.label,
          value: String(optIdx),
        })),
        optional: true,
      });
      fields.push({
        type: 'text_input',
        blockId: `q_${qIdx}_other`,
        label: t('modal.typeAnswerLabel'),
        actionId: 'other_text',
        placeholder: t('modal.customAnswerPlaceholder'),
        optional: true,
      });
    } else {
      // Free-form text only — no select, text_input is required.
      fields.push({
        type: 'text_input',
        blockId: `q_${qIdx}_other`,
        label: t('modal.yourAnswerLabel'),
        actionId: 'other_text',
        placeholder: t('modal.yourAnswerPlaceholder'),
        optional: false,
      });
    }
  }
  const titleIcon = askLevelIcon(group.level);
  return {
    callbackId: 'ask_user_question_modal_submit',
    title: titleIcon ? `${titleIcon} ${t('modal.questionsTitle')}` : t('modal.questionsTitle'),
    submitLabel: t('modal.submit'),
    closeLabel: t('modal.cancel'),
    privateMetadata: JSON.stringify({ groupId: group.groupId }),
    fields,
  };
}

// --- Plan approval builders ---

export function buildPlanApprovalContent(requestId: string): { richBlocks: RichBlock[]; actions: ActionElement[] } {
  return {
    richBlocks: [
      { type: 'section', text: `${Icons.memo} ${t('modal.planReady')}` },
    ],
    actions: [
      { type: 'button', text: t('modal.approve'), actionId: 'hook_plan_approve', value: requestId, style: 'primary' },
      { type: 'button', text: t('modal.provideFeedback'), actionId: 'hook_plan_feedback', value: requestId },
    ],
  };
}

export function buildPlanFeedbackModal(requestId: string): ModalDefinition {
  return {
    callbackId: 'hook_plan_feedback_submit',
    title: t('modal.planFeedbackTitle'),
    submitLabel: t('modal.submit'),
    closeLabel: t('modal.cancel'),
    privateMetadata: JSON.stringify({ requestId }),
    fields: [{
      type: 'text_input',
      blockId: 'feedback',
      label: t('modal.feedbackLabel'),
      actionId: 'text',
      multiline: true,
      placeholder: t('modal.feedbackPlaceholder'),
    }],
  };
}
