// input:  settings buttons, toggles, keyboard handlers
// output: shared control keyboard accessibility tests
// pos:    Settings primitive interaction regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SButton, Toggle } from './settings-ui';

function keyEvent(key: string) {
  return { key, preventDefault: vi.fn() };
}

describe('settings-ui keyboard access', () => {
  it('activates Toggle on Enter and Space when interactive', () => {
    const onClick = vi.fn();
    const renderer = create(<Toggle on={false} onClick={onClick} ariaLabel="Assign Alpha" />);
    const toggle = renderer.root.findByProps({ role: 'switch' });
    const enter = keyEvent('Enter');
    const space = keyEvent(' ');

    act(() => toggle.props.onKeyDown(enter));
    act(() => toggle.props.onKeyDown(space));

    expect(toggle.props.tabIndex).toBe(0);
    expect(toggle.props['aria-label']).toBe('Assign Alpha');
    expect(toggle.props['aria-checked']).toBe(false);
    expect(toggle.props['aria-disabled']).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(space.preventDefault).toHaveBeenCalledOnce();
  });

});

describe('inert settings toggle', () => {
  it('keeps inert Toggle unfocusable and without a keyboard handler', () => {
    const renderer = create(<Toggle on={true} inert />);
    const toggle = renderer.root.findByType('div');

    expect(toggle.props.role).toBe('switch');
    expect(toggle.props['aria-checked']).toBe(true);
    expect(toggle.props['aria-disabled']).toBe(true);
    expect(toggle.props.tabIndex).toBeUndefined();
    expect(toggle.props.onKeyDown).toBeUndefined();
  });

});

describe('settings button keyboard access', () => {
  it('activates SButton on Enter and Space while disabled stays inert', () => {
    const onClick = vi.fn();
    const renderer = create(<SButton tone="accent" onClick={onClick}>Save</SButton>);
    const button = renderer.root.findByProps({ role: 'button' });
    const disabled = create(<SButton tone="neutral" disabled onClick={onClick}>Idle</SButton>);
    const disabledNode = disabled.root.findByType('span');

    act(() => button.props.onKeyDown(keyEvent('Enter')));
    act(() => button.props.onKeyDown(keyEvent(' ')));

    expect(button.props.tabIndex).toBe(0);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(disabledNode.props.role).toBeUndefined();
    expect(disabledNode.props.tabIndex).toBeUndefined();
    expect(disabledNode.props.onKeyDown).toBeUndefined();
  });
});
