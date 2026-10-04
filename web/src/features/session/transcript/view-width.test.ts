import { describe, expect, it } from 'vitest';
import { viewGroupBox, widestViewWidth } from './view-width';

describe('widestViewWidth', () => {
  it('is null without a view, and narrow for views recorded before tiers existed', () => {
    expect(widestViewWidth([{ type: 'file' }])).toBeNull();
    expect(widestViewWidth([{ type: 'view' }])).toBe('narrow');
  });

  it('takes the widest tier in the group and ignores non-view buckets', () => {
    expect(widestViewWidth([{ type: 'view', viewWidth: 'wide' }, { type: 'view' }])).toBe('wide');
    expect(widestViewWidth([{ type: 'view' }, { type: 'view', viewWidth: 'full' }])).toBe('full');
    expect(widestViewWidth([{ type: 'file', viewWidth: 'full' }, { type: 'view' }])).toBe('narrow');
  });
});

describe('viewGroupBox', () => {
  it('keeps narrow inside the prose column', () => {
    expect(viewGroupBox('narrow')).toMatchObject({ width: '92%', marginInline: 'auto' });
  });

  it('breaks the wider tiers out onto the published pane width, centred', () => {
    const wide = viewGroupBox('wide');
    expect(wide.width).toBe('min(var(--chat-bleed-w, 100%), 1040px)');
    expect(wide.marginLeft).toBe(`calc((100% - ${wide.width}) / 2)`);
    const full = viewGroupBox('full');
    expect(full.width).toBe('var(--chat-bleed-w, 100%)');
    expect(full.maxWidth).toBe('none');
  });
});
