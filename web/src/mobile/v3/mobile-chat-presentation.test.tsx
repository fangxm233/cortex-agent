// input:  React SSR, mobile composer and interaction cards
// output: Chat presentation regression tests
// pos:    Guard mobile input sizes and sealed card readability
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MComposer, ComposerFullscreen } from '../ui/composer';
import { MPlanCard, M_INT_COPY } from './MInteractionCards';
import type { PlanCardModel } from '@/features/workbench/interaction-vm';

const noop = () => {};
const plan: PlanCardModel = {
  requestId: 'plan-1', status: 'rejected', title: 'A reviewed plan',
  filePath: 'plans/long-path/plan.md', lineCount: 1, planContent: '# Plan',
  feedback: null, ts: null, timeLabel: '12:00',
};

function planMarkup(model = plan, dimmed = false) {
  return renderToStaticMarkup(<MPlanCard model={model} copy={M_INT_COPY.en} dimmed={dimmed}
    onApprove={noop} onRejectStart={noop} onOpenRead={noop} />);
}

describe('mobile chat presentation', () => {
  it('keeps sealed plans readable without a stacked focus boundary', () => {
    const html = planMarkup();
    expect(html).not.toContain('opacity:');
    expect(html).not.toContain('focus-ring-accent');
    expect(html).not.toContain('backdrop-filter');
    expect(html).toContain('A reviewed plan');
    expect(html).toContain('font-size:11px');
  });

  it('preserves temporary reject-composer dimming', () => {
    expect(planMarkup({ ...plan, status: 'pending' }, true)).toContain('opacity:0.55');
  });

  it('uses 16px inputs in both composer layouts without nesting blur', () => {
    const compact = renderToStaticMarkup(<MComposer placeholder="Message" value="" />);
    const expanded = renderToStaticMarkup(<ComposerFullscreen placeholder="Message" value="" onCollapse={noop} />);
    expect(compact).toMatch(/<textarea[^>]*font-size:16px/);
    expect(expanded).toMatch(/<textarea[^>]*font-size:16px/);
    expect(compact).not.toContain('glass-ring-inset');
    expect(expanded).not.toContain('backdrop-filter');
  });
});
