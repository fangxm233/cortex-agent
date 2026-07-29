// input:  DeskAskCard with leveled and neutral ask models
// output: severity badge markers on the pending ask card
// pos:    Behavior contract for ask-card severity rendering
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskAskCard, D_INT_COPY } from './InteractionCards';
import { emptyDeskAsk, type AskCardModel } from './interaction-vm';

function makeModel(level: AskCardModel['level']): AskCardModel {
  return {
    requestId: 'req-lvl-1',
    shortId: 'req-lvl-',
    status: 'pending',
    level,
    questions: [{ question: 'Proceed?', options: [{ label: 'Yes', description: null }], multiSelect: false, answer: null }],
    ts: new Date().toISOString(),
    timeLabel: '07:38',
  };
}

function render(level: AskCardModel['level']): string {
  return renderToStaticMarkup(
    <DeskAskCard
      model={makeModel(level)}
      state={emptyDeskAsk}
      copy={D_INT_COPY.en}
      onState={() => {}}
      onSubmit={() => {}}
      busy={false}
    />,
  );
}

describe('DeskAskCard severity badge', () => {
  it('marks the card with the level and shows the badge when a level is set', () => {
    const html = render('warning');
    expect(html).toContain('data-ask-level="warning"');
  });

  it('keeps the neutral card free of any level marker', () => {
    const html = render(null);
    expect(html).not.toContain('data-ask-level');
  });
});
