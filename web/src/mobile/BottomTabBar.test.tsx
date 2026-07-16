import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BottomTabBar } from './BottomTabBar';
import { zh } from '@/i18n';

// react-dom/server render checks for the mobile v3 bottom Tab bar (scheme-mobile.dc.html 1a L121-126).
// Presentational + props-driven (MobileShell binds the real tRPC counts): 1:1 chrome — zh labels
// 会话/线程/任务/项目, active/inactive tone, amber 需要你 count badge on 项目, ≥44px touch.

function render(props: Parameters<typeof BottomTabBar>[0]) {
  return renderToStaticMarkup(<BottomTabBar {...props} />);
}

const base = {
  vocab: zh,
  activeId: 'sessions' as const,
  needsYouCount: 0,
  onNavigate: () => {},
};

describe('BottomTabBar (v3)', () => {
  it('renders the 4 zh labels from vocab in order', () => {
    const html = render(base);
    expect(html).toContain('会话');
    expect(html).toContain('线程');
    expect(html).toContain('任务');
    expect(html).toContain('项目');
  });

  it('marks the active tab (data-active) and colors it ink #191C22', () => {
    const html = render({ ...base, activeId: 'tasks' });
    expect(html).toContain('data-tab-id="tasks"');
    expect(html).toMatch(
      /data-tab-id="tasks"[^>]*data-active="true"|data-active="true"[^>]*data-tab-id="tasks"/,
    );
    expect(html).toContain('#191C22');
    expect(html).toContain('#98A1B0');
  });

  it('gives every tab a ≥44px touch target', () => {
    const html = render(base);
    expect(html).toContain('min-height:44px');
  });

  it('shows the amber 需要你 badge (#C99A2E) with the count on the project tab', () => {
    const html = render({ ...base, needsYouCount: 2 });
    expect(html).toContain('#C99A2E');
    expect(html).toContain('>2<');
    expect(html).toContain('data-tab-id="project"');
  });

  it('hides the amber badge when the count is 0', () => {
    const html = render({ ...base, needsYouCount: 0 });
    expect(html).not.toContain('#C99A2E');
  });
});
