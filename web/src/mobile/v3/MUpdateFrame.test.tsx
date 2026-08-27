// input:  mobile frame slots and representative update copy
// output: preserved alert DOM, scrim/card styles, icon, and slotted actions
// pos:    Mobile-only shared update frame characterization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { MUpdateFrame } from './MUpdateFrame';

describe('MUpdateFrame', () => {
  it('preserves the mobile alert frame and shared header DOM', () => {
    const renderer = create(
      <MUpdateFrame title="新版本已就绪" summary="a → b · 8.4 MB" description="后台下载完成。">
        <button>退出 App</button>
      </MUpdateFrame>,
    );
    const overlay = renderer.root.findByProps({ role: 'dialog' });
    const card = overlay.find((node) => node.props.style?.background === 'var(--proto-card)');

    expect(overlay.props['aria-modal']).toBe('true');
    expect(overlay.props['aria-label']).toBe('新版本已就绪');
    expect(overlay.props.style).toMatchObject({
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'var(--overlay-scrim-strong)', padding: '0 36px',
    });
    expect(card.props.style).toMatchObject({
      width: '100%', borderRadius: 18, padding: '24px 20px 14px',
      background: 'var(--proto-card)',
    });
    expect(renderer.root.findByType('svg').props.width).toBe('20');
    expect(renderer.root.findByType('button').children).toEqual(['退出 App']);
    expect(JSON.stringify(renderer.toJSON())).toContain('后台下载完成。');
  });
});
