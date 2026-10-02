import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ prompt: null as any }));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en };
});
vi.mock('@/design/DesktopUpdateFrame', () => ({
  DesktopUpdateFrame: (props: any) => <section role="dialog">{props.description}{props.children}</section>,
}));
vi.mock('@/features/update-prompt/useUpdatePrompt', () => ({ useUpdatePrompt: () => harness.prompt }));
vi.mock('./MAppUpdateDialog', () => ({
  MAppUpdateDialog: (props: any) => <dialog data-update-dialog="app" data-version={props.update.version} />,
}));
vi.mock('./MHotUpdateDialog', () => ({
  MHotUpdateDialog: (props: any) => <dialog data-update-dialog="hot" data-version={props.update.version} />,
}));

import { MUpdateMount } from './MUpdateMount';

let renderer: ReactTestRenderer;
function render(): void {
  act(() => {
    if (renderer) renderer.update(<MUpdateMount />);
    else renderer = create(<MUpdateMount />);
  });
}

beforeEach(() => {
  harness.prompt = null;
  renderer = undefined as unknown as ReactTestRenderer;
});

describe('MUpdateMount', () => {
  it('renders the server prompt on a phone with its install consent', () => {
    const apply = vi.fn();
    harness.prompt = { kind: 'server', status: { available: '2026.10.1', state: 'prompting' },
      busy: false, apply, skip: vi.fn(), dismiss: vi.fn() };
    render();
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    act(() => renderer.root.findAllByType('button').find((b) => b.props.onClick === apply)!.props.onClick());
    expect(apply).toHaveBeenCalledOnce();
  });

  it('renders a page refresh confirmation without refreshing on mount', () => {
    const apply = vi.fn();
    harness.prompt = { kind: 'page', apply, dismiss: vi.fn() };
    render();
    expect(apply).not.toHaveBeenCalled();
    const button = renderer.root.findAllByType('button').find((b) => b.children.includes('Refresh page'))!;
    act(() => button.props.onClick());
    expect(apply).toHaveBeenCalledOnce();
  });
  it('renders the selected app or hot prompt, never both', () => {
    harness.prompt = {
      kind: 'app', update: { version: '2026.8.1', kind: 'apk' }, busy: false,
      error: null, install: vi.fn(), skip: vi.fn(), dismiss: vi.fn(),
    };
    render();
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'app' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'hot' })).toHaveLength(0);

    harness.prompt = {
      kind: 'hot', update: { version: 'frontend-b7e2' }, apply: vi.fn(), dismiss: vi.fn(),
    };
    render();
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'app' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'hot' })).toHaveLength(1);
  });
});
