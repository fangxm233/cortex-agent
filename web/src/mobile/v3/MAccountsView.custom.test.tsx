// input:  custom provider rows and action spies for the accounts view
// output: mobile custom section rendering and delete-arming regressions
// pos:    Verifies the mobile custom provider surface
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot, CustomProviderView } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { buildAccountsVm } from './m-accounts-vm';
import { MAccountsView } from './MAccountsView';

// The editor itself is a bottom sheet, which needs a DOM to mount; its rules are covered by
// custom-provider-vm.test.ts and by the desktop editor, which uses the same view model.

const EMPTY_STATUS: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

const PROVIDER: CustomProviderView = {
  name: 'my-vllm',
  api: 'anthropic-messages',
  models: [{ id: 'Model-27B' }],
  upstreamUrl: 'http://127.0.0.1:8100',
  hasApiKey: true,
  routed: false,
};

function mountView(over: { providers?: CustomProviderView[]; confirmingDelete?: string | null } = {}): {
  renderer: ReactTestRenderer;
  onNew: ReturnType<typeof vi.fn>;
  onEdit: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
} {
  const onNew = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MAccountsView
          vm={buildAccountsVm(EMPTY_STATUS)}
          onBack={() => {}} onLogin={() => {}} onLogout={() => {}} actionsDisabled={false}
          custom={{
            providers: over.providers ?? [PROVIDER],
            confirmingDelete: over.confirmingDelete ?? null,
            onNew, onEdit, onDelete,
          }}
        />
      </LangProvider>,
    );
  });
  return { renderer, onNew, onEdit, onDelete };
}

function button(renderer: ReactTestRenderer, action: string) {
  return renderer.root.findAll(node => node.props['data-cpv-action'] === action)[0];
}

describe('mobile custom providers', () => {
  it('renders a definition with its unrouted warning and key state', () => {
    const html = JSON.stringify(mountView().renderer.toJSON());

    expect(html).toContain('my-vllm');
    expect(html).toContain('anthropic-messages');
    expect(html).toContain('http://127.0.0.1:8100');
    expect(html).toContain('no gateway route');
    expect(html).toContain('key stored');
  });

  it('offers the editor entry points and hands over the tapped provider', () => {
    const view = mountView();

    act(() => { button(view.renderer, 'new').props.onClick(); });
    act(() => { button(view.renderer, 'edit').props.onClick(); });

    expect(view.onNew).toHaveBeenCalledTimes(1);
    expect(view.onEdit).toHaveBeenCalledWith(PROVIDER);
  });

  it('arms a delete before it removes the gateway route', () => {
    const view = mountView();
    act(() => { button(view.renderer, 'delete').props.onClick(); });
    expect(view.onDelete).toHaveBeenCalledWith('my-vllm');

    const armed = mountView({ confirmingDelete: 'my-vllm' });
    expect(JSON.stringify(armed.renderer.toJSON())).toContain('Confirm delete');
  });

  it('says so when nothing is defined yet', () => {
    const html = JSON.stringify(mountView({ providers: [] }).renderer.toJSON());

    expect(html).toContain('No custom providers defined.');
  });
});
