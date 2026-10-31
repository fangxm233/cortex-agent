import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStatusSnapshot, ConnectionView } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { buildAccountsVm } from '@/features/settings/vm/accounts-vm';
import { buildConnectionRows } from '@/features/settings/vm/connections-vm';
import { MAccountsView } from './MAccountsView';

// The editor itself is a bottom sheet, covered by MConnectionSheet.test.tsx; its rules are covered
// by connections-vm.test.ts and by the desktop editor, which uses the same view model.

const EMPTY_STATUS: AuthStatusSnapshot = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

const KEY = 'sk-ant-sentinel-key';
const API: ConnectionView = {
  id: 'api', backend: 'claude', provider: null, kind: 'key', label: 'api', baseUrl: null, authStyle: 'x-api-key',
  billing: 'metered', authenticated: true, keyHint: 'sk-…-key', models: null,
};
const ROWS = buildConnectionRows([API], { connOfficialApi: 'Anthropic API', connAnthropicModels: 'Anthropic models' });

function mountView(over: { confirmingDelete?: string | null; savePending?: boolean; removePending?: boolean } = {}) {
  const onNew = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider>
        <MAccountsView
          vm={buildAccountsVm(EMPTY_STATUS)} filter="" onFilter={() => {}}
          onBack={() => {}} onLogin={() => {}} onLogout={() => {}} actionsDisabled={false}
          onRescan={() => {}} rescanning={false}
          connections={{
            rows: ROWS,
            confirmingDelete: over.confirmingDelete ?? null,
            savePending: over.savePending ?? false,
            removePending: over.removePending ?? false,
            onNew, onEdit, onDelete,
          }}
        />
      </LangProvider>,
    );
  });
  return { renderer, onNew, onEdit, onDelete };
}

function button(renderer: ReactTestRenderer, action: string) {
  return renderer.root.findAll(node => node.props['data-conn-action'] === action)[0];
}

describe('mobile connections', () => {
  it('shows the API-key slot row with its key hint only', () => {
    const view = mountView();
    const json = JSON.stringify(view.renderer.toJSON());
    expect(json).toContain('sk-…-key');
    expect(json).not.toContain(KEY);
    expect(view.renderer.root.findAll(node => node.props['data-conn-api-key-slot'] === '').length).toBeGreaterThan(0);
  });

  it('passes the row to delete and names the effect once armed', () => {
    const view = mountView();
    act(() => { button(view.renderer, 'delete').props.onClick(); });
    expect(view.onDelete).toHaveBeenCalledWith(ROWS[0]);
    const armed = mountView({ confirmingDelete: 'claude:api' });
    expect(armed.renderer.root.findAll(node => node.props['data-conn-risk'] === '').length).toBeGreaterThan(0);
  });

  it('gates save/edit and remove actions independently', () => {
    const saving = mountView({ savePending: true });
    expect(button(saving.renderer, 'new').props.disabled).toBe(true);
    expect(button(saving.renderer, 'edit').props.disabled).toBe(true);
    expect(button(saving.renderer, 'delete').props.disabled).toBe(false);

    const removing = mountView({ removePending: true });
    expect(button(removing.renderer, 'new').props.disabled).toBe(false);
    expect(button(removing.renderer, 'edit').props.disabled).toBe(false);
    expect(button(removing.renderer, 'delete').props.disabled).toBe(true);
  });
});
