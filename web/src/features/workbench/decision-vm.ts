// input:  decision items with their recorded action logs
// output: pure status derivation and outgoing-message composition
// pos:    Shared decision-card rules for desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { DecisionItem } from '@cortex-agent/ui-contract';

// Pure rules behind the decision cards (send_decision). Kept out of the components so both the
// desktop card/modal and the mobile card/sheet derive状态 and compose messages identically, and so
// the rules are testable without React.

/** Card-facing status. `approved` wins over later explain/revise logs — approval is a terminal
 *  acknowledgement (no undo), while explain/revise merely reflect the LATEST conversation move. */
export type DecisionStatus = 'none' | 'approved' | 'explained' | 'revised';

export function decisionStatus(d: DecisionItem): DecisionStatus {
  if (d.actions.some((a) => a.action === 'approve')) return 'approved';
  const last = d.actions[d.actions.length - 1];
  if (!last) return 'none';
  return last.action === 'explain' ? 'explained' : 'revised';
}

/** The i18n templates the composed message is built from ({title} / {text} placeholders). */
export interface DecisionMsgTemplates {
  explain: string;
  /** Explain with no user text — a bare "please explain" referencing the title. */
  explainBare: string;
  revise: string;
}

/**
 * Compose the full message sent to the agent (and recorded on the decision). The CLIENT builds it
 * from the i18n template so the decision linkage (the quoted title) can never be edited away —
 * the user's free text only ever fills the {text} slot. Returns null when the action needs text
 * but has none (revise): callers disable 发送 on null.
 */
export function buildDecisionMessage(
  t: DecisionMsgTemplates,
  action: 'explain' | 'revise',
  title: string,
  text: string,
): string | null {
  const trimmed = text.trim();
  if (action === 'revise') {
    if (!trimmed) return null;
    return t.revise.replace('{title}', title).replace('{text}', trimmed);
  }
  return trimmed
    ? t.explain.replace('{title}', title).replace('{text}', trimmed)
    : t.explainBare.replace('{title}', title);
}
