// input:  Task blocker card and blocker reason fixtures
// output: Desktop task-detail blocker card regressions
// pos:    Rendering tests for conditional blocker details
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskBlockerCard } from './TaskModal';

function render(reason: string | null): string {
  return renderToStaticMarkup(<TaskBlockerCard label="Blocked" reason={reason} />);
}

describe('TaskBlockerCard', () => {
  it('renders the full blocker reason when present', () => {
    const html = render('Waiting for external approval\nthen restart dispatch');

    expect(html).toContain('data-task-blocker-card="true"');
    expect(html).toContain('Blocked');
    expect(html).toContain('Waiting for external approval\nthen restart dispatch');
  });

  it('renders nothing when the task is not blocked', () => {
    expect(render(null)).toBe('');
  });
});
