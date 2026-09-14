import type { ImpliedTaskPattern } from './types.js';

export const RECOMMENDATION_HEADER_RE = /^(#{2,4})\s+(Recommended\s+actions?|Next\s+steps?|Prevention|Implications|Quick\s+wins?|Experiments?\s+needed|Proposed\s+solutions?|What\s+NOT\s+to\s+do)\s*$/i;
export const ANTI_RECOMMENDATION_HEADERS = new Set(['what not to do']);

export const IMPLIED_TASK_PATTERNS: ImpliedTaskPattern[] = [
  {
    pattern: 'failed-success-criterion',
    signals: [
      /\bFAIL\b/,
      /\bdoes\s+not\s+meet\b/i,
      /\bbelow\s+threshold\b/i,
      /\bdid\s+not\s+(?:meet|pass|satisfy|achieve)\b/i,
      /\bnot\s+met\b/i,
      /未达成|未通过|未满足/i,
    ],
    suggested_task_type: 'Refined experiment or protocol redesign',
  },
  {
    pattern: 'insufficient-sample',
    signals: [
      /\bN\s+too\s+small\b/i,
      /\bN\s*=\s*[12]\b/,
      /\bcannot\s+draw\s+conclusions?\b/i,
      /\binsufficient\s+(?:data|sample|evidence)\b/i,
      /\btoo\s+few\s+(?:samples?|data\s+points?|observations?)\b/i,
      /样本不足|数据不足|样本量(?:过小|不够)/i,
    ],
    suggested_task_type: 'Larger-scale replication',
  },
  {
    pattern: 'identified-confound',
    signals: [
      /\bconfound(?:ing)?\b/i,
      /\bcannot\s+(?:separate|disentangle|isolate|distinguish)\b/i,
      /混淆变量|无法分离|无法区分/i,
    ],
    suggested_task_type: 'Controlled follow-up experiment',
  },
  {
    pattern: 'partial-confirmation',
    signals: [
      /\bpartially?\s+(?:confirmed|supported|validated?|verified)\b/i,
      /\beffect\s+exists?\s+but\b/i,
      /部分(?:确认|验证|达成)/i,
    ],
    suggested_task_type: 'Refined hypothesis or targeted investigation',
  },
  {
    pattern: 'unexplained-result',
    signals: [
      /\bunexpected(?:ly)?\b/i,
      /\bcontrary\s+to\b/i,
      /\bmechanism\s+(?:is\s+)?unclear\b/i,
      /\bunexplained\b/i,
      /\bsurprising(?:ly)?\b/i,
      /意外|机制不明|原因不明|出乎预料/i,
    ],
    suggested_task_type: 'Investigation or diagnosis',
  },
  {
    pattern: 'multi-phase-plan',
    signals: [/\bPhase\s+\d+\b/i],
    suggested_task_type: 'Check if all phases have TASKS.md entries',
  },
];

export const ACTION_VERBS = new Set([
  'implement', 'add', 'create', 'fix', 'update', 'remove', 'refactor',
  'test', 'write', 'run', 'design', 'investigate', 'build', 'deploy',
  'configure', 'enable', 'disable', 'migrate', 'extract', 'integrate',
  'validate', 'check', 'verify', 'measure', 'analyze', 'document',
  'define', 'extend', 'split', 'merge', 'rename', 'move', 'replace',
  'convert', 'optimize', 'reduce', 'increase', 'use', 'introduce',
]);

export const NEGATIVE_PATTERNS = [
  /^do\s+not\b/i,
  /^don't\b/i,
  /\bshows?\s+that\b/i,
  /\bsuggests?\s+that\b/i,
  /\bindicates?\s+that\b/i,
  /\bis\s+(the|a)\s+(strongest|weakest|dominant|primary)/i,
];

export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'and', 'or', 'but', 'if', 'than', 'that',
  'this', 'these', 'those', 'it', 'its', 'not', 'no', 'all', 'each',
  'every', 'both', 'any', 'such', 'when', 'where', 'how', 'what', 'which',
]);

export const EXP_HEADER_RE = /^#{2,4}\s+(EXP-\d+\w*)\s*[:：]/i;
export const DATE_RE = /(?:\*\*日期\*\*|\*\*Date\*\*)\s*[:：]\s*(\d{4}-\d{2}-\d{2})/;
export const REFLECTION_FIELDS_RE: Record<string, RegExp> = {
  行为调整: /^[-*]\s*\*?\*?行为调整\*?\*?\s*[:：]\s*(.+)/i,
  过程缺陷: /^[-*]\s*\*?\*?过程缺陷\*?\*?\s*[:：]\s*(.+)/i,
};
export const FINDINGS_HEADER_RE = /^(#{2,4})\s+(?:Findings|结论|Conclusion)\s*$/i;
