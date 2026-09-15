import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const cascade = vi.hoisted(() => ({ check: vi.fn(() => Promise.resolve({} as never)) }));
vi.mock('./manual-update-check', () => ({ checkForUpdates: cascade.check }));

import { ServerUpdateDialog } from './ServerUpdateDialog';
import {
  serverUpdateVisible,
  updateStatusPollMs,
  useShellRecheckCascade,
} from './useServerUpdate';

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('button');
}

describe('ServerUpdateDialog', () => {
  it('offers skip / later / update while prompting', () => {
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    const renderer = create(
      <ServerUpdateDialog
        status={{ available: '2026.9.20', state: 'prompting' }}
        busy={false}
        onApply={actions[0]} onSkip={actions[1]} onDismiss={actions[2]}
      />,
    );
    const frame = renderer.root.findByProps({ 'data-update-frame': true });
    expect(frame.props['data-title']).toBe('新版本可用');
    expect(frame.props['data-summary']).toBe('Cortex 2026.9.20 · 服务端 + 应用');
    expect(frame.props['data-description-id']).toBe('server-update-desc');
    expect(frame.props['data-description']).toContain('只需这一次确认');

    const controls = buttons(renderer);
    expect(controls.map((b) => b.children.join(''))).toEqual(['跳过此版本', '稍后', '更新']);
    act(() => controls.forEach((b) => b.props.onClick()));
    expect(actions.every((a) => a.mock.calls.length === 1)).toBe(true);
  });

  it('shows progress instead of closing optimistically once the install starts', () => {
    const renderer = create(
      <ServerUpdateDialog
        status={{ available: '2026.9.20', state: 'installing' }}
        busy onApply={vi.fn()} onSkip={vi.fn()} onDismiss={vi.fn()}
      />,
    );
    expect(renderer.root.findByProps({ 'data-update-frame': true }).props['data-title'])
      .toBe('正在更新服务端');
    expect(buttons(renderer).map((b) => b.children.join(''))).toEqual(['后台继续']);
  });

  it('surfaces the npm failure text rather than a success it cannot vouch for', () => {
    const renderer = create(
      <ServerUpdateDialog
        status={{ available: '2026.9.20', state: 'failed', error: 'npm install -g exited with code 1' }}
        busy={false} onApply={vi.fn()} onSkip={vi.fn()} onDismiss={vi.fn()}
      />,
    );
    expect(renderer.root.findByType('pre').children.join('')).toBe('npm install -g exited with code 1');
    expect(buttons(renderer).map((b) => b.children.join(''))).toEqual(['关闭']);
  });
});

describe('server update visibility and polling', () => {
  it('hides only on idle, or when this version was dismissed', () => {
    expect(serverUpdateVisible({ available: null, state: 'idle' }, null)).toBe(false);
    expect(serverUpdateVisible({ available: '2026.9.20', state: 'prompting' }, null)).toBe(true);
    expect(serverUpdateVisible({ available: '2026.9.20', state: 'prompting' }, '2026.9.20')).toBe(false);
    expect(serverUpdateVisible({ available: '2026.9.21', state: 'prompting' }, '2026.9.20')).toBe(true);
  });

  it('polls fast only while something is in flight', () => {
    expect(updateStatusPollMs('idle')).toBe(60_000);
    expect(updateStatusPollMs('installing')).toBe(2_000);
    expect(updateStatusPollMs('restarting')).toBe(2_000);
  });
});

function Cascade({ state }: { state: 'idle' | 'prompting' | 'installing' | 'restarting' | 'failed' }) {
  useShellRecheckCascade(state);
  return null;
}

describe('shell re-check cascade', () => {
  beforeEach(() => { cascade.check.mockClear(); });

  it('re-checks the shell the moment the server is back from restarting', () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<Cascade state="installing" />); });
    expect(cascade.check).not.toHaveBeenCalled();

    act(() => { renderer.update(<Cascade state="restarting" />); });
    expect(cascade.check).not.toHaveBeenCalled();

    // The new server process starts with an empty update state, so `idle` IS "it came back".
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledTimes(1);

    // And it stays a one-shot — the shell's own 24h timer owns everything after this.
    act(() => { renderer.update(<Cascade state="prompting" />); });
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).toHaveBeenCalledTimes(1);
  });

  it('does not re-check when no install ever ran', () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<Cascade state="prompting" />); });
    act(() => { renderer.update(<Cascade state="idle" />); });
    expect(cascade.check).not.toHaveBeenCalled();
  });
});
