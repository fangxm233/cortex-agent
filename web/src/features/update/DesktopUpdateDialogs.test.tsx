// input:  both desktop dialogs, representative metadata, and a stub desktop frame
// output: preserved copy, button order/state, and callback semantics after frame extraction
// pos:    Desktop update dialog characterization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./DesktopUpdateFrame', () => ({
  DesktopUpdateFrame: ({ children, ...props }: any) => (
    <section
      data-update-frame
      data-title={props.title}
      data-summary={props.summary}
      data-description-id={props.descriptionId}
      data-description={props.description}
    >
      {children}
    </section>
  ),
}));

import { AppUpdateDialog } from '@/features/app-update/AppUpdateDialog';
import { HotUpdateDialog } from '@/features/hot-update/HotUpdateDialog';

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('button');
}

describe('desktop update dialogs', () => {
  it('preserves app-update copy, error, actions, order, and busy state', () => {
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    const renderer = create(
      <AppUpdateDialog
        update={{ version: '2026.8.1', kind: 'appimage', size: 1024 }}
        busy error="disk full" onInstall={actions[0]} onSkip={actions[1]} onDismiss={actions[2]}
      />,
    );
    const frame = renderer.root.findByProps({ 'data-update-frame': true });
    const controls = buttons(renderer);
    expect(frame.props['data-title']).toBe('App 新版本已就绪');
    expect(frame.props['data-summary']).toBe('Cortex 2026.8.1 · 1 KB · 已下载');
    expect(frame.props['data-description-id']).toBe('app-update-desc');
    expect(renderer.root.findByProps({ className: 'mb-3 text-[11.5px] leading-snug text-state-fail' }).children.join(''))
      .toBe('安装失败：disk full');
    expect(controls.map((button) => button.children.join(''))).toEqual(['跳过此版本', '稍后', '正在处理…']);
    expect(controls[2].props.disabled).toBe(true);
    act(() => controls.forEach((button) => button.props.onClick()));
    expect(actions.every((action) => action.mock.calls.length === 1)).toBe(true);
  });

  it('preserves hot-update copy and restart/ignore semantics', () => {
    const apply = vi.fn();
    const dismiss = vi.fn();
    const renderer = create(
      <HotUpdateDialog
        update={{ version: 'b7e2d999', fromVersion: 'a3f90000', size: 1536 }}
        onApply={apply} onDismiss={dismiss}
      />,
    );
    const frame = renderer.root.findByProps({ 'data-update-frame': true });
    const controls = buttons(renderer);
    expect(frame.props['data-title']).toBe('新版本已就绪');
    expect(frame.props['data-summary']).toBe('a3f90000 → b7e2d999 · 2 KB · 已下载');
    expect(frame.props['data-description-id']).toBe('hot-update-desc');
    expect(controls.map((button) => button.children.join(''))).toEqual(['忽略', '重启 App']);
    act(() => controls[0].props.onClick());
    act(() => controls[1].props.onClick());
    expect(dismiss).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });
});
