import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAskCard, MPlanCard, M_INT_COPY } from './MInteractionCards';
import {
  askCardModel,
  planCardModel,
  emptyAskAnswers,
  commitAnswer,
  type AskAnswerState,
} from '@/features/workbench/interaction-vm';
import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';

// Neutral fixtures (守则11 — nimbus/atlas). Chrome is 1:1 from scheme-mobile.dc.html sec-4/5/6.

const copy = M_INT_COPY.zh;
const noop = (): void => {};

const askDetail = (status: TranscriptInteractionDetail['status'], result?: TranscriptInteractionDetail['result']): TranscriptInteractionDetail => ({
  id: 'req-ask-1',
  kind: 'ask-user',
  status,
  payload: {
    questions: [
      { question: '评审基线用哪组？', header: 'Q1', options: [{ label: 'nimbus baseline' }, { label: 'atlas baseline' }], multiSelect: false },
      { question: '扫描 seed 规模用哪组？', header: 'Q2', options: [{ label: '8 seeds — 复用配置' }, { label: '16 seeds — 置信更高', description: '+$4.20 · +38m' }], multiSelect: false },
      { question: '复检要跑哪些检查？', header: 'Q3', options: [{ label: 'bootstrap 重采样' }, { label: '学习曲线对比' }], multiSelect: true },
    ],
  },
  ...(result ? { result } : {}),
});

const planDetail = (status: TranscriptInteractionDetail['status'], result?: TranscriptInteractionDetail['result']): TranscriptInteractionDetail => ({
  id: 'req-plan-1',
  kind: 'plan-approval',
  status,
  payload: { planContent: '# DR 扫描计划\n\n正文', planFilePath: 'plans/EXP-024-plan.md' },
  ...(result ? { result } : {}),
});

const askHandlers = { onPick: noop, onToggle: noop, onConfirmMulti: noop, onCustom: noop };

describe('MAskCard — 5b 多问题逐问推进', () => {
  it('renders the progress pill, sealed answered row, expanded current question, queued question', () => {
    const state: AskAnswerState = commitAnswer(emptyAskAnswers, '评审基线用哪组？', 'nimbus baseline');
    const html = renderToStaticMarkup(
      <MAskCard model={askCardModel(askDetail('pending'), new Date().toISOString())!} state={state} copy={copy} {...askHandlers} />,
    );
    expect(html).toContain('Agent 提问 · 2/3'); // progress in the pill
    expect(html).toContain('req-ask-'); // short id
    expect(html).toContain('后按默认继续'); // TTL countdown label (real ts)
    // sealed answered row: question → answer
    expect(html).toContain('评审基线用哪组？');
    expect(html).toContain('nimbus baseline');
    // current question expanded with its options + Q2 marker + 默认 badge on the first option
    expect(html).toContain('Q2');
    expect(html).toContain('扫描 seed 规模用哪组？');
    expect(html).toContain('8 seeds — 复用配置');
    expect(html).toContain('默认');
    expect(html).toContain('+$4.20 · +38m'); // real option description as right meta
    expect(html).toContain('自定义…');
    // queued question dimmed
    expect(html).toContain('复检要跑哪些检查？');
    expect(html).toContain('待答');
    // footer
    expect(html).toContain('答一题进一题 · 全答完继续');
  });
  it('omits the ·k/n counter for a single question', () => {
    const detail: TranscriptInteractionDetail = {
      id: 'req-1', kind: 'ask-user', status: 'pending',
      payload: { questions: [{ question: 'A or B?', header: 'Q', options: [{ label: 'A' }], multiSelect: false }] },
    };
    const html = renderToStaticMarkup(
      <MAskCard model={askCardModel(detail)!} state={emptyAskAnswers} copy={copy} {...askHandlers} />,
    );
    expect(html).toContain('Agent 提问');
    expect(html).not.toContain('· 1/1');
    expect(html).not.toContain('后按默认继续'); // no ts → no fabricated TTL
  });
  it('renders a 确认 commit affordance for a multi-select current question', () => {
    let state = commitAnswer(emptyAskAnswers, '评审基线用哪组？', 'nimbus baseline');
    state = commitAnswer(state, '扫描 seed 规模用哪组？', '8 seeds — 复用配置');
    const html = renderToStaticMarkup(
      <MAskCard model={askCardModel(askDetail('pending'))!} state={state} copy={copy} {...askHandlers} />,
    );
    expect(html).toContain('多选');
    expect(html).toContain('确认');
  });
  it('4a sealed answered card: green badge + per-question answers, no option buttons', () => {
    const html = renderToStaticMarkup(
      <MAskCard
        model={askCardModel(askDetail('answered', { answers: { '评审基线用哪组？': 'nimbus baseline', '扫描 seed 规模用哪组？': '16 seeds — 置信更高', '复检要跑哪些检查？': 'bootstrap 重采样' } }), '2026-07-16T07:41:00Z')!}
        state={emptyAskAnswers}
        copy={copy}
        {...askHandlers}
      />,
    );
    expect(html).toContain('✓ 已回答');
    expect(html).toContain('16 seeds — 置信更高');
    expect(html).not.toContain('待答');
    expect(html).not.toContain('自定义…');
  });
});

describe('MPlanCard — 6a 薄卡 + 4b/4c 封存', () => {
  const planHandlers = { onApprove: noop, onRejectStart: noop, onOpenRead: noop };
  it('6a pending: badge + title + file row main entry + approve/reject + footer hint (NO steps)', () => {
    const html = renderToStaticMarkup(
      <MPlanCard model={planCardModel(planDetail('pending'), '2026-07-16T07:38:00Z')} copy={copy} {...planHandlers} />,
    );
    expect(html).toContain('计划待批');
    expect(html).toContain('ExitPlanMode');
    expect(html).toContain('DR 扫描计划'); // heading-derived title, # stripped
    expect(html).toContain('plans/EXP-024-plan.md');
    expect(html).toContain('批准前建议通读全文');
    expect(html).toContain('阅读 ›');
    expect(html).toContain('批准并执行');
    expect(html).toContain('驳回并反馈');
    expect(html).toContain('批准 = 开始执行');
    expect(html).not.toContain('步骤'); // thin card carries no step summary
  });
  it('5a rejecting (dimmed): card dims, buttons collapse to 查看完整计划 ›', () => {
    const html = renderToStaticMarkup(
      <MPlanCard model={planCardModel(planDetail('pending'))} copy={copy} dimmed {...planHandlers} />,
    );
    expect(html).toContain('opacity:0.55');
    expect(html).not.toContain('批准并执行');
    expect(html).toContain('查看完整计划 ›');
  });
  it('4b approved sealed: green badge + 由你批准 + file footer 查看完整计划 ›, no buttons', () => {
    const html = renderToStaticMarkup(
      <MPlanCard model={planCardModel(planDetail('approved'), '2026-07-16T07:41:00Z')} copy={copy} {...planHandlers} />,
    );
    expect(html).toContain('✓ 计划已批准');
    expect(html).toContain('由你批准');
    expect(html).toContain('plans/EXP-024-plan.md');
    expect(html).toContain('查看完整计划 ›');
    expect(html).not.toContain('批准并执行');
  });
  it('4c rejected sealed: grey badge + strikethrough title + 重规划将改写 + feedback user bubble', () => {
    const html = renderToStaticMarkup(
      <MPlanCard model={planCardModel(planDetail('rejected', { feedback: 'friction 上限压到 1.0' }), '2026-07-16T07:44:00Z')} copy={copy} {...planHandlers} />,
    );
    expect(html).toContain('已驳回');
    expect(html).toContain('line-through');
    expect(html).toContain('重规划将改写');
    expect(html).toContain('查看原计划 ›');
    expect(html).toContain('friction 上限压到 1.0'); // real result.feedback as the user bubble
  });
});
