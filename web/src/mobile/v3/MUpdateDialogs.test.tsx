// input:  both mobile dialogs, representative metadata, and a stub mobile frame
// output: preserved copy, button order/state, and touch-action semantics after frame extraction
// pos:    Mobile update dialog characterization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./MUpdateFrame', () => ({
  MUpdateFrame: ({ children, ...props }: any) => (
    <section
      data-update-frame
      data-title={props.title}
      data-summary={props.summary}
      data-description={props.description}
    >
      {children}
    </section>
  ),
}));

import { MAppUpdateDialog } from './MAppUpdateDialog';
import { MHotUpdateDialog } from './MHotUpdateDialog';

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('button');
}

describe('mobile update dialogs', () => {
  it('preserves app-update copy, error, actions, order, and busy state', () => {
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    const renderer = create(
      <MAppUpdateDialog
        update={{ version: '2026.8.1', kind: 'apk', size: 1024 }}
        busy error="permission denied" onInstall={actions[0]} onSkip={actions[1]} onDismiss={actions[2]}
      />,
    );
    const frame = renderer.root.findByProps({ 'data-update-frame': true });
    const controls = buttons(renderer);
    expect(frame.props['data-title']).toBe('App 新版本已就绪');
    expect(frame.props['data-summary']).toBe('Cortex 2026.8.1 · 1 KB · 已下载');
    const error = renderer.root.find((node) => node.props.style?.color === 'var(--proto-danger)');
    expect(error.children.join('')).toBe('安装失败：permission denied');
    expect(controls.map((button) => button.children.join(''))).toEqual(['正在处理…', '跳过此版本', '稍后']);
    expect(controls[0].props.disabled).toBe(true);
    expect(controls[0].props.style.opacity).toBe(0.6);
    act(() => controls.forEach((button) => button.props.onClick()));
    expect(actions.every((action) => action.mock.calls.length === 1)).toBe(true);
  });

  it('preserves hot-update copy and exit/ignore semantics', () => {
    const apply = vi.fn();
    const dismiss = vi.fn();
    const renderer = create(
      <MHotUpdateDialog
        update={{ version: 'b7e2d999', fromVersion: 'a3f90000', size: 1536 }}
        onApply={apply} onDismiss={dismiss}
      />,
    );
    const frame = renderer.root.findByProps({ 'data-update-frame': true });
    const controls = buttons(renderer);
    expect(frame.props['data-title']).toBe('新版本已就绪');
    expect(frame.props['data-summary']).toBe('a3f90000 → b7e2d999 · 2 KB · 已下载');
    expect(controls.map((button) => button.children.join(''))).toEqual(['退出 App', '忽略']);
    act(() => controls[0].props.onClick());
    act(() => controls[1].props.onClick());
    expect(apply).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
