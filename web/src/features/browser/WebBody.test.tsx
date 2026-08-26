// input:  WebBody tab actions and iframe render tree
// output: tab lifetime and independent-control regressions
// pos:    Focused component tests for the browser workspace
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { WebBody } from './WebBody';
import { webItem } from './browser-target';

function input(renderer: ReactTestRenderer) {
  return renderer.root.findByType('input');
}

function navigate(renderer: ReactTestRenderer, url: string): void {
  act(() => input(renderer).props.onChange({ target: { value: url } }));
  act(() => input(renderer).props.onKeyDown({ key: 'Enter' }));
}

describe('WebBody tabs', () => {
  it('keeps inactive iframe elements mounted until their tab closes', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<WebBody item={webItem('')} />); });

    navigate(renderer, 'http://127.0.0.1:5173/');
    const firstFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });

    act(() => renderer.root.findByProps({ 'data-add-tab': '' }).props.onClick());
    expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-browser-tab-body': 'browser-tab-0' }).props.style.display).toBe('none');

    navigate(renderer, 'http://127.0.0.1:3000/');
    expect(renderer.root.findAllByType('iframe')).toHaveLength(2);
    act(() => renderer.root.findByProps({ 'data-browser-tab': 'browser-tab-0' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(firstFrame);
    expect(renderer.root.findByProps({ 'data-browser-tab-body': 'browser-tab-1' }).props.style.display).toBe('none');

    act(() => renderer.root.findByProps({ 'data-close-tab': 'browser-tab-0' }).props.onClick({ stopPropagation() {} }));
    expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-browser-frame': 'browser-tab-0' })).toHaveLength(0);
  });

  it('keeps address drafts and viewport choices independent per tab', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<WebBody item={webItem('')} />); });
    act(() => input(renderer).props.onChange({ target: { value: 'draft-a' } }));
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'phone' } }));
    act(() => renderer.root.findByProps({ 'data-add-tab': '' }).props.onClick());
    act(() => input(renderer).props.onChange({ target: { value: 'draft-b' } }));
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'desktop' } }));

    act(() => renderer.root.findByProps({ 'data-browser-tab': 'browser-tab-0' }).props.onClick());
    expect(input(renderer).props.value).toBe('draft-a');
    expect(renderer.root.findByType('select').props.value).toBe('phone');
    act(() => renderer.root.findByProps({ 'data-browser-tab': 'browser-tab-1' }).props.onClick());
    expect(input(renderer).props.value).toBe('draft-b');
    expect(renderer.root.findByType('select').props.value).toBe('desktop');
  });
});
