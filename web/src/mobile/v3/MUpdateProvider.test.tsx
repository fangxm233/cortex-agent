import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ prompt: null as any }));
vi.mock('@/features/update/useUpdatePrompt', () => ({ useUpdatePrompt: () => harness.prompt }));
vi.mock('./MAppUpdateDialog', () => ({
  MAppUpdateDialog: (props: any) => <dialog data-update-dialog="app" data-version={props.update.version} />,
}));
vi.mock('./MHotUpdateDialog', () => ({
  MHotUpdateDialog: (props: any) => <dialog data-update-dialog="hot" data-version={props.update.version} />,
}));

import { MUpdateProvider } from './MUpdateProvider';

let renderer: ReactTestRenderer;
function render(): void {
  act(() => {
    if (renderer) renderer.update(<MUpdateProvider />);
    else renderer = create(<MUpdateProvider />);
  });
}

beforeEach(() => {
  harness.prompt = null;
  renderer = undefined as unknown as ReactTestRenderer;
});

describe('MUpdateProvider', () => {
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
