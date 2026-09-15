import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ prompt: null as any }));
vi.mock('./useUpdatePrompt', () => ({ useUpdatePrompt: () => harness.prompt }));
vi.mock('@/features/app-update/AppUpdateDialog', () => ({
  AppUpdateDialog: (props: any) => <dialog data-update-dialog="app" data-version={props.update.version} />,
}));
vi.mock('@/features/hot-update/HotUpdateDialog', () => ({
  HotUpdateDialog: (props: any) => <dialog data-update-dialog="hot" data-version={props.update.version} />,
}));
vi.mock('./ServerUpdateDialog', () => ({
  ServerUpdateDialog: (props: any) => <dialog data-update-dialog="server" data-version={props.status.available} />,
}));
vi.mock('./useSilentUpdateNotice', () => ({ useSilentUpdateNotice: () => {} }));

import { UpdateProvider } from './UpdateProvider';

let renderer: ReactTestRenderer;
function render(): void {
  act(() => {
    if (renderer) renderer.update(<UpdateProvider />);
    else renderer = create(<UpdateProvider />);
  });
}

beforeEach(() => {
  harness.prompt = null;
  renderer = undefined as unknown as ReactTestRenderer;
});

describe('UpdateProvider', () => {
  it('renders the server prompt when that is the one selected', () => {
    harness.prompt = {
      kind: 'server', status: { available: '2026.9.20', state: 'prompting' }, busy: false,
      apply: vi.fn(), skip: vi.fn(), dismiss: vi.fn(),
    };
    render();
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'server' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'app' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-update-dialog': 'hot' })).toHaveLength(0);
  });

  it('renders the selected app or hot prompt, never both', () => {
    harness.prompt = {
      kind: 'app', update: { version: '2026.8.1', kind: 'appimage' }, busy: false,
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

  it('renders nothing without a prompt', () => {
    render();
    expect(renderer.toJSON()).toBeNull();
  });
});
