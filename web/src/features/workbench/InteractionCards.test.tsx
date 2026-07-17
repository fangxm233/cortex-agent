import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeskAskCard, DeskPlanCard, D_INT_COPY } from './InteractionCards';
import { askCardModel, planCardModel, emptyDeskAsk, deskTogglePick, deskToggleOther, deskSetOtherText } from './interaction-vm';
import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';

// Desktop interaction cards — chrome 1:1 from scheme.dc.html 13b (AskUserQuestion) / 13c
// (Plan 审批薄卡). Neutral fixtures (守则11).

const copy = D_INT_COPY.zh;
const noop = (): void => {};

const askDetail = (status: TranscriptInteractionDetail['status'], result?: TranscriptInteractionDetail['result']): TranscriptInteractionDetail => ({
  id: 'req-ask-1',
  kind: 'ask-user',
  status,
  payload: {
    questions: [
      { question: 'Seed-6 在结论表里怎么处理？', header: 'Q1', options: [{ label: '保留并标注异常' }, { label: '从结论表剔除' }], multiSelect: false },
      { question: '复检时要额外跑哪些检查？', header: 'Q2', options: [{ label: 'bootstrap 重采样 ×1000' }, { label: '学习曲线对比' }], multiSelect: true },
    ],
  },
  ...(result ? { result } : {}),
});

const planDetail = (status: TranscriptInteractionDetail['status'], result?: TranscriptInteractionDetail['result']): TranscriptInteractionDetail => ({
  id: 'req-plan-1',
  kind: 'plan-approval',
  status,
  payload: { planContent: '# 2×4 消融矩阵\n\n正文', planFilePath: 'plans/plan-ablation.md' },
  ...(result ? { result } : {}),
});

describe('DeskAskCard — 13b pending', () => {
  const model = askCardModel(askDetail('pending'), new Date().toISOString())!;
  const html = renderToStaticMarkup(
    <DeskAskCard model={model} state={emptyDeskAsk} copy={copy} onState={noop} onSubmit={noop} busy={false} />,
  );
  it('renders the 需要你拍板 pill + AskUserQuestion mono + live TTL', () => {
    expect(html).toContain('需要你拍板');
    expect(html).toContain('AskUserQuestion');
    expect(html).toContain('阻塞中 · TTL');
  });
  it('renders ALL questions with 单选/多选 tags and ○/☐ chips + 其他… chip', () => {
    expect(html).toContain('Seed-6 在结论表里怎么处理？');
    expect(html).toContain('复检时要额外跑哪些检查？');
    expect(html).toContain('单选');
    expect(html).toContain('多选');
    expect(html).toContain('○ 保留并标注异常');
    expect(html).toContain('☐ bootstrap 重采样 ×1000');
    expect(html).toContain('其他…');
  });
  it('submit is disabled (grey) until every question is answered', () => {
    expect(html).toContain('提交回答');
    expect(html).toContain('cursor:not-allowed');
  });
  it('marks picked chips ●/☑ and enables submit when complete', () => {
    let s = deskTogglePick(emptyDeskAsk, 0, '保留并标注异常', false);
    s = deskTogglePick(s, 1, '学习曲线对比', true);
    const h = renderToStaticMarkup(
      <DeskAskCard model={model} state={s} copy={copy} onState={noop} onSubmit={noop} busy={false} />,
    );
    expect(h).toContain('● 保留并标注异常');
    expect(h).toContain('☑ 学习曲线对比');
    expect(h).not.toContain('cursor:not-allowed');
  });
  it('expands the 其他… free-text input only when selected', () => {
    let s = deskToggleOther(emptyDeskAsk, 0, false);
    s = deskSetOtherText(s, 0, '双跑对照');
    const h = renderToStaticMarkup(
      <DeskAskCard model={model} state={s} copy={copy} onState={noop} onSubmit={noop} busy={false} />,
    );
    expect(h).toContain('双跑对照');
  });
  it('sealed answered card renders per-question ✓ rows, no submit', () => {
    const h = renderToStaticMarkup(
      <DeskAskCard
        model={askCardModel(askDetail('answered', { answers: { 'Seed-6 在结论表里怎么处理？': '保留并标注异常', '复检时要额外跑哪些检查？': 'bootstrap 重采样 ×1000、奖励项数值范围审计' } }))!}
        state={emptyDeskAsk}
        copy={copy}
        onState={noop}
        onSubmit={noop}
        busy={false}
      />,
    );
    expect(h).toContain('已回答');
    expect(h).toContain('保留并标注异常');
    expect(h).toContain('bootstrap 重采样 ×1000、奖励项数值范围审计');
    expect(h).not.toContain('提交回答');
  });
});

describe('DeskPlanCard — 13c', () => {
  const handlers = { onApprove: noop, onReject: noop, onOpenRead: noop, onFeedbackOpen: noop };
  it('pending default: PLAN pill + title + file row (阅读 ›) + 请求修改/批准计划, no feedback box', () => {
    const html = renderToStaticMarkup(
      <DeskPlanCard model={planCardModel(planDetail('pending'), new Date().toISOString())} copy={copy} feedbackOpen={false} busy={false} {...handlers} />,
    );
    expect(html).toContain('PLAN · 等待批准');
    expect(html).toContain('ExitPlanMode');
    expect(html).toContain('线程暂停中 · TTL');
    expect(html).toContain('2×4 消融矩阵');
    expect(html).toContain('plans/plan-ablation.md');
    expect(html).toContain('已写入 · 批准前建议通读全文');
    expect(html).toContain('阅读 ›');
    expect(html).toContain('批准 = 开始执行');
    expect(html).toContain('请求修改');
    expect(html).toContain('批准计划');
    expect(html).not.toContain('确认退回');
  });
  it('feedback open: amber input + 反馈必填 hint + 取消/确认退回', () => {
    const html = renderToStaticMarkup(
      <DeskPlanCard model={planCardModel(planDetail('pending'))} copy={copy} feedbackOpen busy={false} {...handlers} />,
    );
    expect(html).toContain('#C99A2E'); // amber input ring
    expect(html).toContain('反馈必填 · 确认后退回重新规划');
    expect(html).toContain('取消');
    expect(html).toContain('确认退回');
    expect(html).not.toContain('批准计划');
  });
  it('approved sealed: green pill + 由你批准 + 线程继续执行 + 查看计划 ›, no buttons', () => {
    const html = renderToStaticMarkup(
      <DeskPlanCard model={planCardModel(planDetail('approved'), '2026-07-16T07:41:00Z')} copy={copy} feedbackOpen={false} busy={false} {...handlers} />,
    );
    expect(html).toContain('✓ 计划已批准');
    expect(html).toContain('由你批准');
    expect(html).toContain('· 线程继续执行');
    expect(html).toContain('查看计划 ›');
    expect(html).not.toContain('批准计划');
  });
  it('rejected sealed (4c isomorph): grey pill + strikethrough + feedback bubble', () => {
    const html = renderToStaticMarkup(
      <DeskPlanCard model={planCardModel(planDetail('rejected', { feedback: 'friction 上限压到 1.0' }))} copy={copy} feedbackOpen={false} busy={false} {...handlers} />,
    );
    expect(html).toContain('已驳回');
    expect(html).toContain('line-through');
    // The "· 重规划将改写" / "replanning rewrites it" footer was removed (commit fbf52bd2) — the
    // rejected seal is now the grey pill + strikethrough title + the user's feedback bubble.
    expect(html).not.toContain('重规划将改写');
    expect(html).toContain('friction 上限压到 1.0');
  });
});
